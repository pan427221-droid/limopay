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
  const base        = t.base_fare       || 0;
  const waitTime    = t.wait_time       || 0;
  const greetFee    = t.greet_fee       || 0;
  const carSeatFee  = t.car_seat_fee    || 0;
  const eventWait   = t.event_wait      || 0;
  const discount    = t.discount        || 0;
  const expenses    = t.expenses        || 0;
  const gratuity    = t.gratuity        || 0;
  const fuel        = t.fuel_surcharge  || 0;
  const parking     = t.parking         || 0;
  const airportFee  = t.airport_fee     || 0;
  const tolls       = t.tolls           || 0;

  // Adjusted base: everything that affects the 38%
  const adjustedBase = base + waitTime + greetFee + carSeatFee + eventWait - discount + expenses;

  // Driver earnings
  const earnings =
    (adjustedBase * 0.38) +
    gratuity +    // 100% to driver
    fuel +        // 100% to driver (= 5% of base, already calculated)
    parking +     // 100% to driver
    airportFee;   // 100% to driver
    // tolls — company expense (i-Pass), NOT paid to driver

  return Math.round(earnings * 100) / 100;
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

    const { data: profile, error: upsertError } = await supabase
      .from('profiles')
      .upsert({
        id: req.user.id,
        email: req.user.email,
        full_name: req.user.user_metadata?.full_name || req.user.email,
        avatar_url: req.user.user_metadata?.avatar_url || null,
        role: 'driver',
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

// ── PARSE SCREENSHOT ──────────────────────────────────────────────────────────
app.post('/api/parse-screenshot', requireAuth, async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'No image' });

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-20250514',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: detectImageType(imageBase64), data: imageBase64 } },
          { type: 'text', text: `Extract trip payment data from this limo/rideshare booking screenshot.
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
- booking_id: the reservation/booking number - look for a 7-digit number (do NOT use passenger count, seat numbers, or other numbers)
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
- total: the final "Total Fare" shown at the bottom of the receipt — this is what the client paid` }
        ]
      }]
    });

    const text = response.content[0].text;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(422).json({ error: 'Could not parse image' });
    res.json({ success: true, data: JSON.parse(match[0]) });
  } catch (err) {
    console.error('Parse error:', err);
    res.status(500).json({ error: 'Failed to parse screenshot' });
  }
});

// ── GET TRIPS ─────────────────────────────────────────────────────────────────
app.get('/api/trips', requireAuth, async (req, res) => {
  try {
    const { data: profile } = await supabase.from('profiles').select('role').eq('id', req.user.id).single();
    let query = supabase.from('trips').select('*').order('date', { ascending: false });
    if (!profile || profile.role !== 'manager') query = query.eq('user_id', req.user.id);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch trips' });
  }
});

// ── CREATE TRIP ───────────────────────────────────────────────────────────────
app.post('/api/trips', requireAuth, async (req, res) => {
  try {
    const {
      date, booking_id, base_fare, wait_time, greet_fee, car_seat_count,
      car_seat_fee, event_wait, discount, expenses, gratuity,
      fuel_surcharge, parking, airport_fee, tolls, total, driver_id
    } = req.body;

    const tripData = {
      base_fare:      base_fare      || 0,
      wait_time:      wait_time      || 0,
      greet_fee:      greet_fee      || 0,
      car_seat_count: car_seat_count || 0,
      car_seat_fee:   car_seat_fee   || 0,
      event_wait:     event_wait     || 0,
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
    if (booking_id) {
      const { data: existing } = await supabase
        .from('trips')
        .select('id')
        .eq('booking_id', booking_id)
        .eq('user_id', req.user.id)
        .maybeSingle();
      if (existing) {
        return res.status(409).json({ error: 'Trip with this Booking ID already exists.' });
      }
    }

    const { data, error } = await supabase.from('trips').insert({
      user_id: req.user.id,
      driver_id: driver_id || null,
      date: date || new Date().toISOString().split('T')[0],
      booking_id,
      ...tripData,
      total: total || 0,
      cash_tips: req.body.cash_tips || 0,
      earnings
    }).select().single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('Create trip error:', err);
    res.status(500).json({ error: 'Failed to create trip: ' + err.message });
  }
});

// ── DELETE TRIP ───────────────────────────────────────────────────────────────
app.delete('/api/trips/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('trips').delete()
      .eq('id', req.params.id).eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete trip' });
  }
});

// ── GET PROFILE ───────────────────────────────────────────────────────────────
app.get('/api/profile', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('profiles').select('*').eq('id', req.user.id).single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

app.listen(PORT, () => console.log(`LimoPay backend running on port ${PORT}`));
