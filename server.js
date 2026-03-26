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

// ── REGISTER ─────────────────────────────────────────────────────────────────
app.post('/api/register', requireAuth, async (req, res) => {
  try {
    const { driver_id } = req.body;
    if (!driver_id) return res.status(400).json({ error: 'No driver_id provided' });

    const driverId = driver_id.toString().trim();

    // 1. Check whitelist
    const { data: allowed } = await supabase
      .from('allowed_drivers')
      .select('driver_id')
      .eq('driver_id', driverId)
      .maybeSingle();

    if (!allowed) {
      return res.status(403).json({ error: 'Invalid Driver ID. Contact your manager.' });
    }

    // 2. Check if ID already taken by another user
    const { data: existing } = await supabase
      .from('profiles')
      .select('id')
      .eq('driver_id', driverId)
      .maybeSingle();

    if (existing && existing.id !== req.user.id) {
      return res.status(409).json({ error: 'This Driver ID is already in use.' });
    }

    // 3. Upsert profile (service_role key — no RLS issues)
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
      .select()
      .single();

    if (upsertError) throw upsertError;

    res.json({ success: true, profile });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

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
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: `Extract trip payment data from this limo/rideshare screenshot.
Return ONLY valid JSON with these fields (use null if not found):
{
  "date": "YYYY-MM-DD",
  "booking_id": "string",
  "base_fare": number,
  "gratuity": number,
  "fuel_surcharge": number,
  "wait_time": number,
  "airport_fee": number,
  "tolls": number,
  "total": number
}` }
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
    const { date, booking_id, base_fare, gratuity, fuel_surcharge, wait_time, airport_fee, tolls, total } = req.body;
    const earnings = ((base_fare||0)*0.38) + (gratuity||0) + (fuel_surcharge||0) + (wait_time||0) + (airport_fee||0) + (tolls||0);
    const { data, error } = await supabase.from('trips').insert({
      user_id: req.user.id,
      date: date || new Date().toISOString().split('T')[0],
      booking_id, base_fare: base_fare||0, gratuity: gratuity||0,
      fuel_surcharge: fuel_surcharge||0, wait_time: wait_time||0,
      airport_fee: airport_fee||0, tolls: tolls||0,
      total: total||0, earnings: Math.round(earnings*100)/100
    }).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create trip' });
  }
});

// ── DELETE TRIP ───────────────────────────────────────────────────────────────
app.delete('/api/trips/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('trips').delete().eq('id', req.params.id).eq('user_id', req.user.id);
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
