import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
const PORT = process.env.PORT || 3000;

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// ─── CLIENTS ─────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });

  req.user = user;
  next();
}

// ─── PARSE SCREENSHOT ────────────────────────────────────────────────────────
app.post('/api/parse-screenshot', requireAuth, async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-20250514',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 }
          },
          {
            type: 'text',
            text: `Extract trip payment data from this limo/rideshare screenshot. 
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
}`
          }
        ]
      }]
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(422).json({ error: 'Could not parse image' });

    const parsed = JSON.parse(jsonMatch[0]);
    res.json({ success: true, data: parsed });

  } catch (err) {
    console.error('Parse error:', err);
    res.status(500).json({ error: 'Failed to parse screenshot' });
  }
});

// ─── GET TRIPS ────────────────────────────────────────────────────────────────
app.get('/api/trips', requireAuth, async (req, res) => {
  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', req.user.id)
      .single();

    let query = supabase.from('trips').select('*').order('date', { ascending: false });

    // Drivers only see their own trips
    if (!profile || profile.role !== 'manager') {
      query = query.eq('user_id', req.user.id);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, data });
  } catch (err) {
    console.error('Get trips error:', err);
    res.status(500).json({ error: 'Failed to fetch trips' });
  }
});

// ─── CREATE TRIP ──────────────────────────────────────────────────────────────
app.post('/api/trips', requireAuth, async (req, res) => {
  try {
    const {
      date, booking_id, base_fare, gratuity,
      fuel_surcharge, wait_time, airport_fee, tolls, total
    } = req.body;

    // Calculate driver earnings: adjusted base × 38% + gratuity + extras
    const adjusted_base = base_fare || 0;
    const earnings = (adjusted_base * 0.38) + (gratuity || 0) + (fuel_surcharge || 0) +
                     (wait_time || 0) + (airport_fee || 0) + (tolls || 0);

    const { data, error } = await supabase.from('trips').insert({
      user_id: req.user.id,
      date: date || new Date().toISOString().split('T')[0],
      booking_id,
      base_fare: adjusted_base,
      gratuity: gratuity || 0,
      fuel_surcharge: fuel_surcharge || 0,
      wait_time: wait_time || 0,
      airport_fee: airport_fee || 0,
      tolls: tolls || 0,
      total: total || 0,
      earnings: Math.round(earnings * 100) / 100
    }).select().single();

    if (error) throw error;
    res.json({ success: true, data });

  } catch (err) {
    console.error('Create trip error:', err);
    res.status(500).json({ error: 'Failed to create trip' });
  }
});

// ─── DELETE TRIP ──────────────────────────────────────────────────────────────
app.delete('/api/trips/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from('trips')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id); // can only delete own trips

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Delete trip error:', err);
    res.status(500).json({ error: 'Failed to delete trip' });
  }
});

// ─── GET PROFILE ──────────────────────────────────────────────────────────────
app.get('/api/profile', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', req.user.id)
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('Get profile error:', err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`LimoPay backend running on port ${PORT}`);
});
