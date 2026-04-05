import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '20mb' }));

const supabase  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });
  req.user = user;
  next();
}

// ── EARNINGS CALCULATOR ───────────────────────────────────────────────────────
// Source of truth for formula. Must match frontend calcEarnings() exactly.
function calcEarnings(t) {
  const base       = t.base_fare       || 0;
  const wait       = t.wait_time       || 0;
  const greet      = t.greet_fee       || 0;  // $40 fixed checkbox
  const carSeat    = t.car_seat_fee    || 0;  // $20 first, +$10 each additional
  const eventWait  = t.event_wait      || 0;
  const extraStop  = t.extra_stop      || 0;
  const holidayPay = t.holiday_pay     || 0;  // $20 fixed checkbox
  const discount   = t.discount        || 0;
  const expenses   = t.expenses        || 0;
  const gratuity   = t.gratuity        || 0;  // 100% to driver
  const fuel       = t.fuel_surcharge  || 0;  // 100% to driver
  const parking    = t.parking         || 0;  // 100% to driver
  const airport    = t.airport_fee     || 0;  // 100% to driver
  // tolls — company expense (i-Pass), NOT paid to driver

  const adjBase = base + wait + greet + carSeat + eventWait + extraStop + holidayPay - discount + expenses;
  const earnings = (adjBase * 0.38) + gratuity + fuel + parking + airport;

  return Math.round(earnings * 100) / 100;
}

// ── REGISTER ──────────────────────────────────────────────────────────────────
app.post('/api/register', requireAuth, async (req, res) => {
  try {
    const { driver_id } = req.body;
    if (!driver_id) return res.status(400).json({ error: 'No driver_id provided' });
    const driverId = driver_id.toString().trim();
    if (!/^\d{4}$/.test(driverId)) return res.status(400).json({ error: 'Driver ID must be 4 digits' });

    const { data: allowed } = await supabase
      .from('allowed_drivers').select('driver_id').eq('driver_id', driverId).maybeSingle();
    if (!allowed) return res.status(403).json({ error: 'Invalid Driver ID. Contact your manager.' });

    const { data: existing } = await supabase
      .from('profiles').select('id').eq('driver_id', driverId).maybeSingle();
    if (existing && existing.id !== req.user.id)
      return res.status(409).json({ error: 'This Driver ID is already in use.' });

    const { data: existingProf } = await supabase
      .from('profiles').select('role').eq('id', req.user.id).maybeSingle();

    const { data: profile, error } = await supabase
      .from('profiles')
      .upsert({
        id:         req.user.id,
        email:      req.user.email,
        full_name:  req.user.user_metadata?.full_name || req.user.email,
        avatar_url: req.user.user_metadata?.avatar_url || null,
        role:       existingProf?.role || 'driver',
        driver_id:  driverId,
      }, { onConflict: 'id' })
      .select().single();

    if (error) throw error;
    res.json({ success: true, profile });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ── IMAGE TYPE DETECTION ──────────────────────────────────────────────────────
function detectImageType(base64) {
  if (base64.startsWith('/9j/'))   return 'image/jpeg';
  if (base64.startsWith('iVBORw')) return 'image/png';
  if (base64.startsWith('R0lGOD')) return 'image/gif';
  if (base64.startsWith('UklGR'))  return 'image/webp';
  return 'image/jpeg';
}

// ── PARSE SCREENSHOT ──────────────────────────────────────────────────────────
const PARSE_PROMPT = `Extract trip payment data from this limo/rideshare booking screenshot.
Return ONLY valid JSON with these fields (use null if not found):
{
  "date": "YYYY-MM-DD",
  "booking_id": "string",
  "base_fare": number,
  "wait_time": number,
  "greet_fee": number,
  "car_seat_fee": number,
  "event_wait": number,
  "extra_stop": number,
  "holiday_pay": number,
  "discount": number,
  "expenses": number,
  "gratuity": number,
  "fuel_surcharge": number,
  "parking": number,
  "airport_fee": number,
  "tolls": number,
  "total": number
}
Rules:
- booking_id: 7-digit number that appears AFTER the word "Reservation". Do NOT use passenger count, seat numbers, or other numbers.
- base_fare: base/booking fare before any additions
- wait_time: waiting charge (billed per 15 min at $15 each)
- greet_fee: meet & greet airport fee ($40 fixed)
- car_seat_fee: child car seat charge ($20 first, $10 each additional)
- event_wait: waiting at events (concerts, games) — fixed dollar amount
- extra_stop: extra stop fee
- holiday_pay: holiday pay if shown ($20 fixed)
- discount: any discount applied (positive number)
- expenses: expense reimbursement
- gratuity: tip/gratuity
- fuel_surcharge: fuel surcharge
- parking: parking fee paid by driver
- airport_fee: airport terminal entry fee
- tolls: road tolls
- total: the final "Total Fare" shown at bottom of receipt`;

async function parseSingleImage(base64) {
  const response = await anthropic.messages.create({
    model: 'claude-opus-4-20250514',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: detectImageType(base64), data: base64 } },
        { type: 'text', text: PARSE_PROMPT }
      ]
    }]
  });
  const text  = response.content[0].text;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse image');
  return JSON.parse(match[0]);
}

// Multi-image merge: first image is primary.
// Subsequent images fill ONLY missing (null/0) fields. No summing.
const NUMERIC_FIELDS = ['base_fare','wait_time','greet_fee','car_seat_fee','event_wait','extra_stop','holiday_pay','discount','expenses','gratuity','fuel_surcharge','parking','airport_fee','tolls','total'];
const STRING_FIELDS  = ['date','booking_id'];

function mergeResults(results) {
  const merged = { ...results[0] };
  for (let i = 1; i < results.length; i++) {
    for (const f of STRING_FIELDS)  if (!merged[f]         && results[i][f]) merged[f] = results[i][f];
    for (const f of NUMERIC_FIELDS) if (!(merged[f] > 0)   && results[i][f]) merged[f] = results[i][f];
  }
  return merged;
}

app.post('/api/parse-screenshot', requireAuth, async (req, res) => {
  try {
    const { imageBase64, images } = req.body;
    const imageList = images
      ? (Array.isArray(images) ? images : [images])
      : (imageBase64 ? [imageBase64] : null);

    if (!imageList?.length) return res.status(400).json({ error: 'No image(s) provided' });

    const results = await Promise.all(imageList.map(b64 => parseSingleImage(b64)));
    const merged  = results.length === 1 ? results[0] : mergeResults(results);

    res.json({ success: true, data: merged });
  } catch (err) {
    console.error('Parse error:', err);
    res.status(500).json({ error: 'Failed to parse screenshot' });
  }
});

// ── GET TRIPS ─────────────────────────────────────────────────────────────────
// Driver: own trips, excluding deleted_by='driver'
// Manager: ALL trips from all drivers, excluding deleted_by='manager'
app.get('/api/trips', requireAuth, async (req, res) => {
  try {
    const { data: profile } = await supabase
      .from('profiles').select('role').eq('id', req.user.id).single();
    const isManager = profile?.role === 'manager';

    let query = supabase
      .from('trips').select('*')
      .order('date', { ascending: false })
      .order('created_at', { ascending: false });

    if (isManager) {
      // Manager sees all drivers; hide only manager-deleted trips
      query = query.or('deleted_by.is.null,deleted_by.eq.driver');
    } else {
      // Driver sees own trips; hide only driver-deleted trips
      query = query
        .eq('user_id', req.user.id)
        .or('deleted_by.is.null,deleted_by.eq.manager');
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('Get trips error:', err);
    res.status(500).json({ error: 'Failed to fetch trips' });
  }
});

// ── CREATE TRIP ───────────────────────────────────────────────────────────────
app.post('/api/trips', requireAuth, async (req, res) => {
  try {
    const {
      date, booking_id, base_fare, wait_time, greet_fee,
      car_seat_count, car_seat_fee, event_wait, extra_stop, holiday_pay,
      discount, expenses, gratuity, fuel_surcharge, parking,
      airport_fee, tolls, total, cash_tips, driver_id
    } = req.body;

    if (!booking_id) return res.status(400).json({ error: 'Booking ID is required' });
    if (!/^\d{7}$/.test(booking_id)) return res.status(400).json({ error: 'Booking ID must be exactly 7 digits' });
    if (!base_fare || base_fare <= 0) return res.status(400).json({ error: 'Base Fare must be > 0' });
    if (!total     || total     <= 0) return res.status(400).json({ error: 'Total Fare must be > 0' });

    // Duplicate check: block if exists where deleted_by IS NULL or deleted_by = 'manager'
    // Allow reuse if deleted_by = 'driver' (driver can re-enter after self-deleting)
    const { data: duplicate } = await supabase
      .from('trips')
      .select('id')
      .eq('booking_id', booking_id)
      .eq('user_id', req.user.id)
      .or('deleted_by.is.null,deleted_by.eq.manager')
      .maybeSingle();

    if (duplicate) return res.status(409).json({ error: 'Trip with this Booking ID already exists.' });

    const tripData = {
      base_fare:      base_fare      || 0,
      wait_time:      wait_time      || 0,
      greet_fee:      greet_fee      || 0,
      car_seat_count: car_seat_count || 0,
      car_seat_fee:   car_seat_fee   || 0,
      event_wait:     event_wait     || 0,
      extra_stop:     extra_stop     || 0,
      holiday_pay:    holiday_pay    || 0,
      discount:       discount       || 0,
      expenses:       expenses       || 0,
      gratuity:       gratuity       || 0,
      fuel_surcharge: fuel_surcharge || 0,
      parking:        parking        || 0,
      airport_fee:    airport_fee    || 0,
      tolls:          tolls          || 0,
    };

    const earnings = calcEarnings(tripData);

    const { data, error } = await supabase.from('trips').insert({
      user_id:    req.user.id,
      driver_id:  driver_id || null,
      date:       date || new Date().toISOString().split('T')[0],
      booking_id,
      ...tripData,
      total:      total     || 0,
      cash_tips:  cash_tips || 0,
      earnings,
      deleted_by: null,
    }).select().single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('Create trip error:', err);
    res.status(500).json({ error: 'Failed to create trip: ' + err.message });
  }
});

// ── UPDATE TRIP ───────────────────────────────────────────────────────────────
app.patch('/api/trips/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      date, booking_id, base_fare, wait_time, greet_fee,
      car_seat_count, car_seat_fee, event_wait, extra_stop, holiday_pay,
      discount, expenses, gratuity, fuel_surcharge, parking,
      airport_fee, tolls, total, cash_tips
    } = req.body;

    if (!booking_id) return res.status(400).json({ error: 'Booking ID is required' });
    if (!/^\d{7}$/.test(booking_id)) return res.status(400).json({ error: 'Booking ID must be exactly 7 digits' });
    if (!base_fare || base_fare <= 0) return res.status(400).json({ error: 'Base Fare must be > 0' });
    if (!total     || total     <= 0) return res.status(400).json({ error: 'Total Fare must be > 0' });

    const { data: profile } = await supabase.from('profiles').select('role').eq('id', req.user.id).single();
    const isManager = profile?.role === 'manager';

    const { data: existing } = await supabase.from('trips').select('*').eq('id', id).maybeSingle();
    if (!existing) return res.status(404).json({ error: 'Trip not found' });
    if (!isManager && existing.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    // Duplicate check excluding current trip
    const { data: duplicate } = await supabase
      .from('trips')
      .select('id')
      .eq('booking_id', booking_id)
      .eq('user_id', existing.user_id)
      .neq('id', id)
      .or('deleted_by.is.null,deleted_by.eq.manager')
      .maybeSingle();

    if (duplicate) return res.status(409).json({ error: 'Another trip with this Booking ID already exists.' });

    const tripData = {
      base_fare:      base_fare      || 0,
      wait_time:      wait_time      || 0,
      greet_fee:      greet_fee      || 0,
      car_seat_count: car_seat_count || 0,
      car_seat_fee:   car_seat_fee   || 0,
      event_wait:     event_wait     || 0,
      extra_stop:     extra_stop     || 0,
      holiday_pay:    holiday_pay    || 0,
      discount:       discount       || 0,
      expenses:       expenses       || 0,
      gratuity:       gratuity       || 0,
      fuel_surcharge: fuel_surcharge || 0,
      parking:        parking        || 0,
      airport_fee:    airport_fee    || 0,
      tolls:          tolls          || 0,
    };

    const earnings = calcEarnings(tripData);

    // Build audit diff
    const newVals = { ...tripData, date, booking_id, total: total || 0, cash_tips: cash_tips || 0 };
    const diff = {};
    for (const f of Object.keys(newVals)) {
      if (String(existing[f]) !== String(newVals[f])) diff[f] = { from: existing[f], to: newVals[f] };
    }

    const { data, error } = await supabase.from('trips')
      .update({
        date, booking_id,
        ...tripData,
        total:     total     || 0,
        cash_tips: cash_tips || 0,
        earnings,
        edited_at: new Date().toISOString(),
        edit_diff: Object.keys(diff).length ? diff : null,
      })
      .eq('id', id)
      .select().single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('Update trip error:', err);
    res.status(500).json({ error: 'Failed to update trip: ' + err.message });
  }
});

// ── DELETE TRIP (soft delete) ─────────────────────────────────────────────────
app.delete('/api/trips/:id', requireAuth, async (req, res) => {
  try {
    const { data: profile } = await supabase.from('profiles').select('role').eq('id', req.user.id).single();
    const isManager = profile?.role === 'manager';

    const { data: trip } = await supabase.from('trips').select('id,user_id').eq('id', req.params.id).maybeSingle();
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    if (!isManager && trip.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const { error } = await supabase.from('trips')
      .update({ deleted_by: isManager ? 'manager' : 'driver' })
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Delete trip error:', err);
    res.status(500).json({ error: 'Failed to delete trip' });
  }
});

// ── FUEL EXPENSES ─────────────────────────────────────────────────────────────
app.post('/api/fuel-expenses', requireAuth, async (req, res) => {
  try {
    const { date, amount } = req.body;
    if (!date)               return res.status(400).json({ error: 'Date is required' });
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount must be > 0' });

    const { data, error } = await supabase.from('fuel_expenses')
      .upsert({ user_id: req.user.id, date, amount }, { onConflict: 'user_id,date' })
      .select().single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('Fuel expense error:', err);
    res.status(500).json({ error: 'Failed to save fuel expense: ' + err.message });
  }
});

app.get('/api/fuel-expenses', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('fuel_expenses')
      .select('*')
      .eq('user_id', req.user.id)
      .order('date', { ascending: false })
      .limit(30);

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('Fuel expense fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch fuel expenses' });
  }
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`LimoPay backend running on port ${PORT}`));
