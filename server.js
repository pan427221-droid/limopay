import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
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
function calcEarnings(t) {
  const base       = parseFloat(t.base_fare)      || 0;
  const wait       = parseFloat(t.wait_time)      || 0;
  const greetFee   = parseFloat(t.greet_fee)      || 0;
  const carSeatFee = parseFloat(t.car_seat_fee)   || 0;
  const eventWait  = parseFloat(t.event_wait)     || 0;
  const extraStop  = parseFloat(t.extra_stop)     || 0;
  const holidayPay = parseFloat(t.holiday_pay)    || 0;
  const discount   = parseFloat(t.discount)       || 0;
  const expenses   = parseFloat(t.expenses)       || 0;
  const gratuity   = parseFloat(t.gratuity)       || 0;
  const fuel       = parseFloat(t.fuel_surcharge) || 0;
  const parking    = parseFloat(t.parking)        || 0;
  const airport    = parseFloat(t.airport_fee)    || 0;

  const adjustedBase = base + wait + greetFee + carSeatFee + eventWait + extraStop - discount + expenses;
  return Math.round(((adjustedBase * 0.38) + gratuity + fuel + parking + airport + holidayPay) * 100) / 100;
}

// ── REGISTER ─────────────────────────────────────────────────────────────────
app.post('/api/register', requireAuth, async (req, res) => {
  try {
    const { driver_id } = req.body;
    if (!driver_id) return res.status(400).json({ error: 'No driver_id provided' });
    const driverId = driver_id.toString().trim();

    const { data: allowed } = await supabase
      .from('allowed_drivers').select('driver_id').eq('driver_id', driverId).maybeSingle();
    if (!allowed) return res.status(403).json({ error: 'Invalid Driver ID. Contact your manager.' });

    const { data: existing } = await supabase
      .from('profiles').select('id').eq('driver_id', driverId).maybeSingle();
    if (existing && existing.id !== req.user.id)
      return res.status(409).json({ error: 'This Driver ID is already in use.' });

    // Get existing profile to preserve role
    const { data: existingProf } = await supabase
      .from('profiles').select('role').eq('id', req.user.id).maybeSingle();

    const { data: profile, error: upsertError } = await supabase
      .from('profiles')
      .upsert({
        id: req.user.id,
        email: req.user.email,
        full_name: req.user.user_metadata?.full_name || req.user.email,
        avatar_url: req.user.user_metadata?.avatar_url || null,
        role: existingProf?.role || 'driver',
        driver_id: driverId
      }, { onConflict: 'id' })
      .select().single();

    if (upsertError) throw upsertError;
    res.json({ success: true, profile });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ── DETECT IMAGE TYPE ─────────────────────────────────────────────────────────
function detectImageType(base64) {
  if (base64.startsWith('/9j/'))   return 'image/jpeg';
  if (base64.startsWith('iVBORw')) return 'image/png';
  if (base64.startsWith('R0lGOD')) return 'image/gif';
  if (base64.startsWith('UklGR'))  return 'image/webp';
  return 'image/jpeg';
}

// ── PARSE SCREENSHOT PROMPT ───────────────────────────────────────────────────
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
  "discount": number,
  "expenses": number,
  "gratuity": number,
  "fuel_surcharge": number,
  "parking": number,
  "airport_fee": number,
  "tolls": number,
  "total": number
}
Notes:
- booking_id: look specifically for the word "Reservation" followed by a 7-digit number (e.g. "Reservation 3909603" → "3909603"). Do NOT use passenger count, seat numbers, phone numbers, or any other 7-digit number that is not preceded by "Reservation".
- base_fare: the base/booking fare before any additions
- wait_time: waiting charge (billed per 15min at $15 each)
- greet_fee: meet & greet airport fee ($40 fixed)
- car_seat_fee: child car seat charge ($20 first, $10 each additional)
- event_wait: waiting at events (concerts, games) if shown
- discount: any discount applied (positive number)
- expenses: expense reimbursement to partially offset discount
- gratuity: tip/gratuity
- fuel_surcharge: fuel surcharge
- parking: parking fee paid by driver
- airport_fee: airport terminal entry fee
- tolls: road tolls
- total: the final "Total Fare" shown at the bottom of the receipt — this is what the client paid`;

// ── MERGE PARSED RESULTS ──────────────────────────────────────────────────────
// Strategy: first image is the "primary" receipt (base data).
// Additional images fill in ONLY fields that are null/0 in the primary.
// This treats multi-photo as "same receipt, different angles" — no summing.
const NUMERIC_FIELDS = ['base_fare','wait_time','greet_fee','car_seat_fee','event_wait','discount','expenses','gratuity','fuel_surcharge','parking','airport_fee','tolls','total'];
const STRING_FIELDS  = ['date','booking_id'];

function mergeResults(results) {
  // Start with first image as base
  const merged = { ...results[0] };
  // Fill missing fields from subsequent images (never overwrite existing values)
  for (let i = 1; i < results.length; i++) {
    for (const field of STRING_FIELDS) {
      if (!merged[field] && results[i][field]) merged[field] = results[i][field];
    }
    for (const field of NUMERIC_FIELDS) {
      if ((!merged[field] || merged[field] === 0) && results[i][field]) {
        merged[field] = results[i][field];
      }
    }
  }
  return merged;
}

// ── PARSE SINGLE IMAGE ────────────────────────────────────────────────────────
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
  const text = response.content[0].text;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse image');
  return JSON.parse(match[0]);
}

// ── PARSE SCREENSHOT ──────────────────────────────────────────────────────────
app.post('/api/parse-screenshot', requireAuth, async (req, res) => {
  try {
    // Support both single image (legacy) and array of images
    const { imageBase64, images } = req.body;

    const imageList = images
      ? (Array.isArray(images) ? images : [images])
      : (imageBase64 ? [imageBase64] : null);

    if (!imageList || imageList.length === 0)
      return res.status(400).json({ error: 'No image provided' });

    if (imageList.length === 1) {
      // Single image — original behaviour
      const data = await parseSingleImage(imageList[0]);
      return res.json({ success: true, data });
    }

    // Multiple images — parse in parallel then merge
    const results = await Promise.all(imageList.map(img => parseSingleImage(img)));
    const data = mergeResults(results);
    res.json({ success: true, data, sources: results.length });

  } catch (err) {
    console.error('Parse error:', err);
    res.status(500).json({ error: 'Failed to parse screenshot' });
  }
});

// ── GET TRIPS (власні тріпи — для всіх включно з менеджером) ─────────────────
app.get('/api/trips', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('trips')
      .select('*')
      .eq('user_id', req.user.id)
      .or('deleted_by.is.null,deleted_by.eq.manager') // показуємо NULL і 'manager', але не 'driver'
      .order('date', { ascending: false })
      .order('id', { ascending: false });
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('Get trips error:', err);
    res.status(500).json({ error: 'Failed to fetch trips' });
  }
});

// ── GET ALL TRIPS (тільки для менеджера — Dashboard) ─────────────────────────
app.get('/api/trips/all', requireAuth, async (req, res) => {
  try {
    const { data: profile } = await supabase.from('profiles').select('role').eq('id', req.user.id).single();
    if (!profile || profile.role !== 'manager')
      return res.status(403).json({ error: 'Access denied' });

    const { data, error } = await supabase
      .from('trips')
      .select('*')
      .or('deleted_by.is.null,deleted_by.eq.driver') // показуємо NULL і 'driver', але не 'manager'
      .order('date', { ascending: false })
      .order('id', { ascending: false });
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('Get all trips error:', err);
    res.status(500).json({ error: 'Failed to fetch trips' });
  }
});

// ── CREATE TRIP ───────────────────────────────────────────────────────────────
app.post('/api/trips', requireAuth, async (req, res) => {
  try {
    const {
      date, booking_id, base_fare, wait_time, greet_fee, car_seat_count,
      car_seat_fee, event_wait, extra_stop, holiday_pay, discount, expenses, gratuity,
      fuel_surcharge, parking, airport_fee, tolls, total, driver_id
    } = req.body;

    // Required fields validation
    if (!booking_id) return res.status(400).json({ error: 'Booking ID is required.' });
    if (!base_fare || base_fare <= 0) return res.status(400).json({ error: 'Base Fare is required.' });
    if (!total || total <= 0) return res.status(400).json({ error: 'Total Fare is required.' });

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

    // Check for duplicate booking
    const { data: existing } = await supabase
      .from('trips')
      .select('id')
      .eq('booking_id', booking_id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (existing) {
      return res.status(409).json({ error: 'Trip with this Booking ID already exists.' });
    }

    const { data, error } = await supabase.from('trips').insert({
      user_id:   req.user.id,
      driver_id: driver_id || null,
      date:      date || new Date().toISOString().split('T')[0],
      booking_id,
      ...tripData,
      total:     total,
      cash_tips: req.body.cash_tips || 0,
      earnings,
      deleted_by: null
    }).select().single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('Create trip error:', err);
    res.status(500).json({ error: 'Failed to create trip: ' + err.message });
  }
});

// ── EDIT TRIP ─────────────────────────────────────────────────────────────────
app.put('/api/trips/:id', requireAuth, async (req, res) => {
  try {
    const { data: existing, error: fetchErr } = await supabase
      .from('trips').select('*').eq('id', req.params.id).single();
    if (fetchErr || !existing) return res.status(404).json({ error: 'Trip not found' });

    // Only owner or manager can edit
    const { data: profile } = await supabase.from('profiles').select('role').eq('id', req.user.id).single();
    const isManager = profile?.role === 'manager';
    if (!isManager && existing.user_id !== req.user.id)
      return res.status(403).json({ error: 'Access denied' });

    const NUMERIC_FIELDS = ['base_fare','wait_time','greet_fee','car_seat_fee','event_wait',
      'extra_stop','holiday_pay','discount','expenses','gratuity','fuel_surcharge',
      'parking','airport_fee','tolls','total','cash_tips'];
    const STRING_FIELDS = ['date','booking_id'];

    // Build diff — compare only changed fields
    const diff = {};
    [...NUMERIC_FIELDS, ...STRING_FIELDS].forEach(field => {
      if (req.body[field] !== undefined) {
        const oldVal = existing[field];
        const newVal = NUMERIC_FIELDS.includes(field) ? (parseFloat(req.body[field]) || 0) : req.body[field];
        if (String(oldVal) !== String(newVal)) {
          diff[field] = { was: oldVal, now: newVal };
        }
      }
    });

    if (Object.keys(diff).length === 0)
      return res.status(400).json({ error: 'No changes detected.' });

    const {
      date, booking_id, base_fare, wait_time, greet_fee, car_seat_count,
      car_seat_fee, event_wait, extra_stop, holiday_pay, discount, expenses, gratuity,
      fuel_surcharge, parking, airport_fee, tolls, total, cash_tips
    } = req.body;

    const tripData = {
      base_fare: parseFloat(base_fare)||0, wait_time: parseFloat(wait_time)||0,
      greet_fee: parseFloat(greet_fee)||0, car_seat_fee: parseFloat(car_seat_fee)||0,
      event_wait: parseFloat(event_wait)||0, extra_stop: parseFloat(extra_stop)||0,
      holiday_pay: parseFloat(holiday_pay)||0, discount: parseFloat(discount)||0,
      expenses: parseFloat(expenses)||0, gratuity: parseFloat(gratuity)||0,
      fuel_surcharge: parseFloat(fuel_surcharge)||0, parking: parseFloat(parking)||0,
      airport_fee: parseFloat(airport_fee)||0, tolls: parseFloat(tolls)||0,
    };
    const earnings = calcEarnings(tripData);

    const { data, error } = await supabase.from('trips').update({
      date, booking_id,
      ...tripData,
      car_seat_count: car_seat_count || 0,
      total: parseFloat(total)||0,
      cash_tips: parseFloat(cash_tips)||0,
      earnings,
      edited_at: new Date().toISOString(),
      // Only save diff on first edit (preserve original diff)
      edit_diff: existing.edit_diff || diff,
    }).eq('id', req.params.id).select().single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('Edit trip error:', err);
    res.status(500).json({ error: 'Failed to edit trip: ' + err.message });
  }
});
app.delete('/api/trips/:id', requireAuth, async (req, res) => {
  try {
    const { data: profile } = await supabase
      .from('profiles').select('role').eq('id', req.user.id).single();
    const role = profile?.role || 'driver';

    // Get trip to verify access
    const { data: trip } = await supabase
      .from('trips').select('id, user_id, deleted_by').eq('id', req.params.id).maybeSingle();
    if (!trip) return res.status(404).json({ error: 'Trip not found' });

    // Driver can only delete own trips; manager can delete any
    if (role !== 'manager' && trip.user_id !== req.user.id)
      return res.status(403).json({ error: 'Access denied' });

    // Soft delete — mark who deleted it
    const deletedBy = role === 'manager' ? 'manager' : 'driver';
    const { error } = await supabase
      .from('trips')
      .update({ deleted_by: deletedBy })
      .eq('id', req.params.id);
    if (error) throw error;

    res.json({ success: true, deleted_by: deletedBy });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete trip' });
  }
});

// ── GET PROFILE ───────────────────────────────────────────────────────────────
app.get('/api/profile', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('profiles').select('*').eq('id', req.user.id).maybeSingle();
    if (error) throw error;
    res.json({ success: true, data: data || null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ── FUEL EXPENSES ─────────────────────────────────────────────────────────────
app.get('/api/fuel', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('fuel_expenses')
      .select('*')
      .eq('user_id', req.user.id)
      .order('date', { ascending: false });
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch fuel expenses' });
  }
});

app.post('/api/fuel', requireAuth, async (req, res) => {
  try {
    const { date, amount, driver_id } = req.body;
    if (!date) return res.status(400).json({ error: 'Date is required' });
    const { data, error } = await supabase
      .from('fuel_expenses')
      .upsert({
        user_id:   req.user.id,
        driver_id: driver_id || null,
        date,
        amount:    parseFloat(amount) || 0,
      }, { onConflict: 'user_id,date' })
      .select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save fuel expense' });
  }
});

app.listen(PORT, () => console.log(`LimoPay backend running on port ${PORT}`));
