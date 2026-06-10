const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const express = require('express');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const PROHIBITED_FILE = path.join(__dirname, 'prohibited.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function loadProhibited() {
  return JSON.parse(fs.readFileSync(PROHIBITED_FILE, 'utf8'));
}

function saveProhibited(data) {
  fs.writeFileSync(PROHIBITED_FILE, JSON.stringify(data, null, 2));
}

function normalize(str) {
  return str.toLowerCase().replace(/[\s\-_]/g, '');
}

function findInProhibited(query) {
  const { models } = loadProhibited();
  const q = normalize(query);
  return models.find(m => {
    const full = normalize(`${m.brand} ${m.model}`);
    const modelOnly = normalize(m.model);
    return q === full || q === modelOnly;
  });
}

app.get('/api/check', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'No query provided' });

  const prohibited = findInProhibited(query);
  if (prohibited) {
    return res.json({
      permitted: false,
      source: 'prohibited_list',
      model: `${prohibited.brand} ${prohibited.model}`,
      reason: prohibited.reason
    });
  }

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      messages: [
        {
          role: 'user',
          content: `I need to determine if the calculator "${query}" is alphanumeric or programmable for an exam.

Exam rule: Students may only use calculators that are silent, cordless, handheld and NOT alphanumeric or programmable. Graphing calculators are strictly prohibited.

Please search for information about this calculator model and answer:
1. Is it alphanumeric (has a full QWERTY or alphabetic keyboard)?
2. Is it programmable (can store and run programs)?
3. Is it a graphing calculator?

Respond in JSON format only:
{
  "permitted": true or false,
  "reason": "specific reason based on the calculator's features"
}

If the calculator is NOT alphanumeric, NOT programmable, and NOT a graphing calculator, it is permitted (true). Otherwise it is not permitted (false). If you cannot find information about this calculator model, set permitted to null and explain in the reason.`
        }
      ]
    });

    // Collect all text blocks (web_search tool may produce multiple)
    const allText = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    const jsonMatch = allText.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) {
      console.error('Raw response content:', JSON.stringify(response.content, null, 2));
      throw new Error('No JSON in response');
    }

    const result = JSON.parse(jsonMatch[0]);
    // Strip citation tags injected by web search (e.g. <cite index="1-1">...</cite>)
    if (result.reason) {
      result.reason = result.reason.replace(/<cite[^>]*>|<\/cite>/g, '');
    }
    result.source = 'ai_check';
    result.model = query;
    res.json(result);
  } catch (err) {
    console.error('AI check error:', err);
    res.status(500).json({ error: 'Failed to check calculator. Please try again.' });
  }
});

app.post('/api/admin/verify', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false, error: 'Incorrect password' });
  }
});

app.get('/api/admin/list', (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  res.json(loadProhibited());
});

app.post('/api/admin/add', (req, res) => {
  const { password, brand, model, reason } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  if (!brand || !model) return res.status(400).json({ error: 'Brand and model required' });

  const data = loadProhibited();
  data.models.push({ brand, model, reason: reason || 'alphanumeric or programmable calculator' });
  saveProhibited(data);
  res.json({ ok: true });
});

app.delete('/api/admin/remove/:index', (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  const data = loadProhibited();
  const idx = parseInt(req.params.index);
  if (idx < 0 || idx >= data.models.length) return res.status(400).json({ error: 'Invalid index' });

  data.models.splice(idx, 1);
  saveProhibited(data);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
