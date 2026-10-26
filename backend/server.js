const path = require('path');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const express = require('express');
const dotenv = require('dotenv');
const OpenAI = require('openai');

const backendEnvPath = path.resolve(__dirname, 'env/.env');
const projectEnvPath = path.resolve(__dirname, '../env/.env');
dotenv.config({ path: fs.existsSync(backendEnvPath) ? backendEnvPath : projectEnvPath });

const app = express();
const projectRoot = path.resolve(__dirname, '..');
const frontendPath = path.join(projectRoot, 'frontend');
const menuPath = path.join(projectRoot, 'data', 'menu.json');
const timingPath = path.join(projectRoot, 'data', 'timing.json');
const timingsPath = fs.existsSync(timingPath) ? timingPath : path.join(projectRoot, 'data', 'timings.json');
const systemPromptPath = path.join(projectRoot, 'prompts', 'system-prompt.md');
const port = Number(process.env.PORT) || 3000;

app.use(express.json());

app.post('/api/chat', async (req, res) => {
  const { message, conversationHistory } = req.body ?? {};
  if (typeof message !== 'string' || message.trim() === '') {
    return res.status(400).json({ error: 'A non-empty message is required.' });
  }

  let menu;
  let timings;
  let systemPrompt;
  let contextSource = 'menu JSON';
  try {
    const menuContents = await fsPromises.readFile(menuPath, 'utf8');
    menu = JSON.parse(menuContents);
    if (
      !menu ||
      typeof menu.currency !== 'string' ||
      !Array.isArray(menu.items) ||
      menu.items.some(item =>
        !item ||
        typeof item.category !== 'string' ||
        typeof item.name !== 'string' ||
        typeof item.description !== 'string' ||
        !Number.isFinite(item.price_pln) ||
        typeof item.available !== 'boolean'
      )
    ) {
      const error = new Error('Menu JSON has an invalid structure.');
      error.code = 'INVALID_MENU_JSON';
      throw error;
    }

    contextSource = 'opening hours JSON';
    const timingsContents = await fsPromises.readFile(timingsPath, 'utf8');
    timings = JSON.parse(timingsContents);
    const validTime = value => {
      if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return false;
      return true;
    };
    if (
      !timings ||
      !Array.isArray(timings.hours) ||
      timings.hours.length === 0 ||
      timings.hours.some(entry =>
        !entry ||
        typeof entry.days !== 'string' ||
        !validTime(entry.open) ||
        !validTime(entry.close)
      )
    ) {
      const error = new Error('Opening hours JSON has an invalid structure.');
      error.code = 'INVALID_TIMINGS_JSON';
      throw error;
    }

    contextSource = 'system prompt';
    systemPrompt = await fsPromises.readFile(systemPromptPath, 'utf8');
    if (!systemPrompt.trim()) {
      const error = new Error('System prompt is empty.');
      error.code = 'EMPTY_SYSTEM_PROMPT';
      throw error;
    }
  } catch (error) {
    console.error(contextSource === 'opening hours JSON'
      ? 'CafeBot could not load its opening hours data.'
      : 'CafeBot could not load its context files.', {
      source: contextSource,
      name: error?.name,
      code: error?.code || (error instanceof SyntaxError
        ? contextSource === 'opening hours JSON' ? 'INVALID_TIMINGS_JSON' : 'INVALID_MENU_JSON'
        : undefined),
    });
    return res.status(500).json({
      reply: 'Sorry, CafeBot’s cafe information is unavailable right now. Please try again later.',
    });
  }

  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'your_openai_api_key_here') {
    return res.status(503).json({
      reply: 'Sorry, CafeBot is not connected right now. Please try again later.',
    });
  }

  try {
    const history = Array.isArray(conversationHistory)
      ? conversationHistory
          .filter(item =>
            item &&
            (item.role === 'user' || item.role === 'assistant') &&
            typeof item.content === 'string'
          )
          .slice(-10)
          .map(item => ({ role: item.role, content: item.content.slice(0, 4000) }))
      : [];
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    let currentTimeContext = 'Cafe timezone is unknown or invalid. Do not determine whether the cafe is open now; explain that CafeBot cannot verify current open status without a configured timezone.';
    const timeZone = process.env.TZ?.trim();
    if (timeZone) {
      try {
        const parts = new Intl.DateTimeFormat('en-GB', {
          timeZone,
          weekday: 'long',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).formatToParts(new Date());
        const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
        currentTimeContext = `Cafe timezone: ${timeZone}. Current local day and time: ${values.weekday}, ${values.hour}:${values.minute}.`;
      } catch {
        currentTimeContext = 'Cafe timezone is unknown or invalid. Do not determine whether the cafe is open now; explain that CafeBot cannot verify current open status without a configured timezone.';
      }
    }
    const response = await openai.responses.create({
      model: 'gpt-6-luna',
      instructions: `${systemPrompt.trim()}\n\nCurrent menu data (JSON):\n${JSON.stringify(menu)}\n\nCurrent opening hours data (JSON):\n${JSON.stringify(timings)}\n\n${currentTimeContext}`,
      input: [...history, { role: 'user', content: message.trim().slice(0, 4000) }],
      max_output_tokens: 300,
    });

    if (!response.output_text?.trim()) {
      throw new Error('OpenAI response did not contain text.');
    }

    return res.json({ reply: response.output_text.trim() });
  } catch (error) {
    const message = typeof error?.message === 'string' ? error.message : 'Unknown OpenAI SDK error.';
    const apiKey = process.env.OPENAI_API_KEY;
    const safeMessage = (apiKey ? message.split(apiKey).join('[REDACTED]') : message)
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
    console.error('CafeBot OpenAI request failed.', {
      message: safeMessage,
      status: error?.status,
      type: error?.type,
      code: error?.code,
    });
    return res.status(502).json({
      reply: 'Sorry, I am having trouble responding right now. Please try again shortly.',
    });
  }
});

app.use(express.static(frontendPath));

if (require.main === module) {
  app.listen(port, () => {
    console.log(`CafeBot is running at http://localhost:${port}`);
  });
}

module.exports = app;
