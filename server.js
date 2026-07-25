const express = require('express');
const app = express();

app.use(express.json({ limit: '5mb' }));

function respond(res, decision, reason) {
  return res.status(200).json({ decision, reason });
}

function normalizeWhitespace(str) {
  return str.replace(/\s+/g, ' ').trim();
}

function canonicalize(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => k !== 'trace_id').sort();
    const out = {};
    for (const k of keys) out[k] = canonicalize(value[k]);
    return out;
  }
  if (typeof value === 'string') return normalizeWhitespace(value);
  return value;
}

function canonicalKey(tool, args) {
  return JSON.stringify({ tool: tool, args: canonicalize(args) });
}

function evaluate(budgetTokens, steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { decision: 'continue', reason: 'No steps taken yet; nothing to evaluate.' };
  }

  const budget = typeof budgetTokens === 'number' ? budgetTokens : Number(budgetTokens);

  let total = 0;
  for (const s of steps) {
    const t = s && typeof s.tokens_used === 'number' ? s.tokens_used : Number(s && s.tokens_used) || 0;
    total += t;
  }

  if (total >= budget) {
    return { decision: 'halt', reason: `Cumulative tokens_used (${total}) has reached the budget (${budget}).` };
  }

  const keys = steps.map((s) => canonicalKey(s.tool, s.args));

  let runLen = 1;
  for (let i = keys.length - 1; i > 0; i--) {
    if (keys[i] === keys[i - 1]) {
      runLen++;
      if (runLen >= 3) {
        return { decision: 'halt', reason: 'The same tool call repeated 3 or more times in a row with functionally identical arguments.' };
      }
    } else {
      break;
    }
  }

  const n = keys.length;
  if (n >= 6) {
    const last6 = keys.slice(n - 6);
    const A = last6[0];
    const B = last6[1];
    if (A !== B) {
      let isCycle = true;
      for (let i = 0; i < 6; i++) {
        if (last6[i] !== (i % 2 === 0 ? A : B)) { isCycle = false; break; }
      }
      if (isCycle) {
        return { decision: 'halt', reason: 'The trailing steps show a 2-step alternating cycle repeating for 6 or more steps.' };
      }
    }
  }

  return { decision: 'continue', reason: 'Within budget and no repeated-call or cyclic-loop pattern detected.' };
}

app.post('/check', (req, res) => {
  try {
    const body = req.body || {};
    const { decision, reason } = evaluate(body.budget_tokens, body.steps);
    return respond(res, decision, reason);
  } catch (err) {
    return respond(res, 'halt', 'Error while evaluating run history.');
  }
});

app.get('/', (req, res) => res.send('Run budget and loop guard endpoint is running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
