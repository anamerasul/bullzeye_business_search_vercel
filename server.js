require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const XLSX = require('xlsx');
const TelegramBot = require('node-telegram-bot-api');

// -------------------- Setup --------------------
const app = express();
const PORT = process.env.PORT || 3000;
const SERP_API_KEY = process.env.SERP_API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const countryMap = {
  usa: 'us',
  uk: 'gb',
  australia: 'au',
  canada: 'ca',
};

const allowedEngines = ['google_maps', 'google', 'bing_maps', 'apple_maps'];

let latestBusinesses = [];
let latestFilename = 'businesses.xlsx';

// -------------------- Helper: fetch businesses (NO pagination) --------------------
async function fetchBusinesses(searchQuery, region, engine = 'google_maps') {
  try {
    // Build SerpApi params
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

    // Extract results based on engine type
    let rawResults = [];
    if (engine === 'google_maps') {
      rawResults = response.data.local_results || [];
    } else if (engine === 'google') {
      rawResults = response.data.local_results || response.data.organic_results || [];
    } else if (engine === 'bing_maps' || engine === 'apple_maps') {
      rawResults = response.data.places || [];
    }

    return rawResults;
  } catch (error) {
    console.error('Error fetching data:', error.response?.data || error.message);
    return [];
  }
}

// -------------------- Routes --------------------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/search', async (req, res) => {
  const { keyword, country, city, engine } = req.body;

  if (!keyword || !country) {
    return res.status(400).json({ error: 'Keyword and country are required' });
  }

  const region = countryMap[country.toLowerCase()];
  if (!region) return res.status(400).json({ error: 'Invalid country selected' });

  const selectedEngine = allowedEngines.includes(engine) ? engine : 'google_maps';

  const searchQuery = city
    ? `${keyword} in ${city}, ${country}`
    : `${keyword} in ${country}`;

  try {
    const businessesRaw = await fetchBusinesses(searchQuery, region, selectedEngine);

    const businesses = businessesRaw.map(b => ({
      name: b.title || b.name || 'No Name',
      address: b.address || b.street_address || 'N/A',
      phone: b.phone || 'N/A',
      website: b.website || b.url || 'N/A',
      rating: b.rating || 'N/A',
      reviews: b.reviews || b.review_count || 'N/A',
    }));

    latestBusinesses = businesses;

    const safeKeyword = keyword.trim().replace(/\s+/g, '_');
    const safeCity = city ? city.trim().replace(/\s+/g, '_') : '';
    const safeCountry = country.trim().replace(/\s+/g, '_');
    latestFilename = `${safeKeyword}${safeCity ? '_' + safeCity : ''}_${safeCountry}.xlsx`;

    res.json({ businesses });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to fetch data from SerpAPI' });
  }
});

app.get('/download-excel', (req, res) => {
  if (!latestBusinesses || latestBusinesses.length === 0) {
    return res.status(400).send('No data to export');
  }

  const worksheet = XLSX.utils.json_to_sheet(latestBusinesses);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Businesses');

  const buf = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Disposition', `attachment; filename="${latestFilename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// -------------------- Telegram Bot --------------------
function escapeMarkdown(text) {
  if (!text) return '';
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function extractEmails(text) {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/gi;
  const matches = text.match(emailRegex);
  return matches ? [...new Set(matches)] : [];
}

async function scrapeEmailsFromWebsite(url) {
  try {
    const res = await axios.get(url, { timeout: 8000 });
    return extractEmails(res.data);
  } catch {
    return [];
  }
}

async function startBot() {
  try {
    await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteWebhook`);
    console.log('Deleted webhook, bot now polling...');
  } catch (err) {
    console.error('Webhook delete failed:', err.message);
  }

  const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

  bot.onText(/\/start/, msg => {
    bot.sendMessage(msg.chat.id, `Welcome! Send:\n/ keyword , city , country [, engine]\n\nCity and engine are optional.\nAvailable engines: google_maps, google, bing_maps, apple_maps\nExample:\n/ seo , new york , usa , google`);
  });

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text || !text.startsWith('/')) return;

    const parts = text.slice(1).split(',').map(p => p.trim());

    if (parts.length < 2) {
      return bot.sendMessage(chatId, 'Format: / keyword , city , country [, engine]\nExample: / seo , new york , usa , google_maps');
    }

    const keyword = parts[0];
    const city = parts.length >= 4 ? parts[1] : (parts.length === 3 ? parts[1] : '');
    const country = parts.length >= 4 ? parts[2].toLowerCase() : (parts.length === 3 ? parts[2].toLowerCase() : parts[1].toLowerCase());
    const engine = parts.length === 4 ? parts[3].toLowerCase() : 'google_maps';

    if (!countryMap[country]) {
      return bot.sendMessage(chatId, 'Allowed countries: usa, uk, australia, canada');
    }
    if (!allowedEngines.includes(engine)) {
      return bot.sendMessage(chatId, `Allowed engines: ${allowedEngines.join(', ')}`);
    }

    const gl = countryMap[country];
    const q = city ? `${keyword} in ${city}, ${country}` : `${keyword} in ${country}`;

    bot.sendMessage(chatId, `Searching for *${escapeMarkdown(keyword)}* in *${escapeMarkdown(city)}, ${escapeMarkdown(country.toUpperCase())}* using *${engine}*`, { parse_mode: 'Markdown' });

    try {
      let params = {
        engine,
        q,
        api_key: SERP_API_KEY,
      };
      if (engine === 'google_maps' || engine === 'google') {
        params.gl = gl;
        params.hl = 'en';
      }

      const serpResponse = await axios.get('https://serpapi.com/search.json', { params });

      let rawBusinesses = [];
      if (engine === 'google_maps') {
        rawBusinesses = serpResponse.data.local_results || [];
      } else if (engine === 'google') {
        rawBusinesses = serpResponse.data.local_results || serpResponse.data.organic_results || [];
      } else if (engine === 'bing_maps' || engine === 'apple_maps') {
        rawBusinesses = serpResponse.data.places || [];
      }

      if (rawBusinesses.length === 0) {
        return bot.sendMessage(chatId, 'No businesses found.');
      }

      for (const b of rawBusinesses.slice(0, 10)) {
        let emails = b.website ? await scrapeEmailsFromWebsite(b.website) : [];

        let text = `*${escapeMarkdown(b.title || b.name || 'No Name')}*\n`;
        text += `Address: ${escapeMarkdown(b.address || b.street_address || 'N/A')}\n`;
        text += `Phone: ${escapeMarkdown(b.phone || 'N/A')}\n`;
        text += `Website: ${escapeMarkdown(b.website || b.url || 'N/A')}\n`;
        text += `Rating: ${escapeMarkdown(b.rating?.toString() || 'N/A')} (${escapeMarkdown(b.reviews?.toString() || '0')} reviews)\n`;
        text += `Emails: ${emails.length ? emails.map(escapeMarkdown).join(', ') : 'None found'}\n`;

        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
      }
    } catch (err) {
      console.error(err);
      bot.sendMessage(chatId, 'Something went wrong. Try again later.');
    }
  });
}

// -------------------- Start Server --------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startBot();
});
