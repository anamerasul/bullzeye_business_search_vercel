require('dotenv').config();
const express = require('express');
const axios = require('axios');
const XLSX = require('xlsx');
const path = require('path');

const app = express();

const PORT = process.env.PORT || 3000;
const SERP_API_KEY = process.env.SERP_API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

const countryMap = {
  usa: 'us',
  uk: 'gb',
  australia: 'au',
  canada: 'ca',
};

const allowedEngines = ['google_maps', 'google', 'bing_maps', 'apple_maps'];

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from public folder (for css, js, images)
app.use(express.static(path.join(__dirname, 'public')));

// Serve index.html on root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// -------------------- Helper: fetch businesses --------------------
async function fetchBusinesses(searchQuery, region, engine = 'google_maps') {
  try {
    let params = {
      engine,
      q: searchQuery,
      api_key: SERP_API_KEY,
    };
    if (engine === 'google_maps' || engine === 'google') {
      params.gl = region;
      params.hl = 'en';
    }
    const response = await axios.get('https://serpapi.com/search.json', { params });

    if (engine === 'google_maps') return response.data.local_results || [];
    if (engine === 'google') return response.data.local_results || response.data.organic_results || [];
    if (engine === 'bing_maps' || engine === 'apple_maps') return response.data.places || [];

    return [];
  } catch (err) {
    console.error('Error fetching:', err.message);
    return [];
  }
}

// -------------------- Routes --------------------

app.post('/search', async (req, res) => {
  const { keyword, country, city, engine } = req.body;

  if (!keyword || !country) {
    return res.status(400).json({ error: 'Keyword and country are required' });
  }

  const region = countryMap[country.toLowerCase()];
  if (!region) return res.status(400).json({ error: 'Invalid country selected' });

  const selectedEngine = allowedEngines.includes(engine) ? engine : 'google_maps';
  const searchQuery = city ? `${keyword} in ${city}, ${country}` : `${keyword} in ${country}`;

  try {
    const rawResults = await fetchBusinesses(searchQuery, region, selectedEngine);

    const businesses = rawResults.map(b => ({
      name: b.title || b.name || 'No Name',
      address: b.address || b.street_address || 'N/A',
      phone: b.phone || 'N/A',
      website: b.website || b.url || 'N/A',
      rating: b.rating || 'N/A',
      reviews: b.reviews || b.review_count || 'N/A',
    }));

    res.json({ businesses });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch data from SerpAPI' });
  }
});

// Excel download route: expects POST with { businesses: [...], filename: "file.xlsx" }
app.post('/download-excel', (req, res) => {
  const { businesses, filename = 'businesses.xlsx' } = req.body;

  if (!businesses || !Array.isArray(businesses) || businesses.length === 0) {
    return res.status(400).send('No data to export');
  }

  const worksheet = XLSX.utils.json_to_sheet(businesses);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Businesses');

  const buf = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// -------------------- Telegram webhook handler --------------------

function escapeMarkdown(text) {
  if (!text) return '';
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

async function scrapeEmailsFromWebsite(url) {
  try {
    const res = await axios.get(url, { timeout: 8000 });
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/gi;
    const matches = res.data.match(emailRegex);
    return matches ? [...new Set(matches)] : [];
  } catch {
    return [];
  }
}

app.post(`/telegram-webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  const body = req.body;
  if (!body.message || !body.message.text) return res.status(200).send('No message');

  const chatId = body.message.chat.id;
  const text = body.message.text;

  if (!text.startsWith('/')) {
    // Ignore non-command messages
    return res.status(200).send('Ignored');
  }

  // Parse command: / keyword , city , country [, engine]
  const parts = text.slice(1).split(',').map(p => p.trim());

  if (parts.length < 2) {
    await sendTelegramMessage(chatId, 'Format: / keyword , city , country [, engine]\nExample: / seo , new york , usa , google_maps');
    return res.status(200).send('Bad format');
  }

  const countryMapKeys = Object.keys(countryMap);
  const keyword = parts[0];
  const city = parts.length >= 4 ? parts[1] : (parts.length === 3 ? parts[1] : '');
  const country = parts.length >= 4 ? parts[2].toLowerCase() : (parts.length === 3 ? parts[2].toLowerCase() : parts[1].toLowerCase());
  const engine = parts.length === 4 ? parts[3].toLowerCase() : 'google_maps';

  if (!countryMapKeys.includes(country)) {
    await sendTelegramMessage(chatId, 'Allowed countries: usa, uk, australia, canada');
    return res.status(200).send('Invalid country');
  }
  if (!allowedEngines.includes(engine)) {
    await sendTelegramMessage(chatId, `Allowed engines: ${allowedEngines.join(', ')}`);
    return res.status(200).send('Invalid engine');
  }

  const gl = countryMap[country];
  const q = city ? `${keyword} in ${city}, ${country}` : `${keyword} in ${country}`;

  await sendTelegramMessage(chatId, `Searching for *${escapeMarkdown(keyword)}* in *${escapeMarkdown(city || 'N/A')}, ${escapeMarkdown(country.toUpperCase())}* using *${engine}*`, { parse_mode: 'Markdown' });

  try {
    const businessesRaw = await fetchBusinesses(q, gl, engine);

    if (businessesRaw.length === 0) {
      await sendTelegramMessage(chatId, 'No businesses found.');
      return res.status(200).send('No businesses found');
    }

    for (const b of businessesRaw.slice(0, 10)) {
      const emails = b.website ? await scrapeEmailsFromWebsite(b.website) : [];

      let msg = `*${escapeMarkdown(b.title || b.name || 'No Name')}*\n`;
      msg += `Address: ${escapeMarkdown(b.address || b.street_address || 'N/A')}\n`;
      msg += `Phone: ${escapeMarkdown(b.phone || 'N/A')}\n`;
      msg += `Website: ${escapeMarkdown(b.website || b.url || 'N/A')}\n`;
      msg += `Rating: ${escapeMarkdown(b.rating?.toString() || 'N/A')} (${escapeMarkdown(b.reviews?.toString() || '0')} reviews)\n`;
      msg += `Emails: ${emails.length ? emails.map(escapeMarkdown).join(', ') : 'None found'}\n`;

      await sendTelegramMessage(chatId, msg, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error(err);
    await sendTelegramMessage(chatId, 'Something went wrong. Try again later.');
  }

  return res.status(200).send('OK');
});

async function sendTelegramMessage(chatId, text, options = {}) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text,
      ...options,
    });
  } catch (err) {
    console.error('Telegram send message error:', err.message);
  }
}

// -------------------- Start Express server (for local dev only) --------------------
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Set your Telegram webhook to: https://yourdomain.com/telegram-webhook/${TELEGRAM_TOKEN}`);
  });
}

module.exports = app;
