const express = require('express');
const app = express();

app.use(express.json({ limit: '5mb' }));

function respond(res, decision, reason) {
  return res.status(200).json({ decision, reason });
}

// ---------- coercion helpers ----------

function toNumber(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Number(v);
  return 0;
}

// ---------- canonicalization ----------

function normalizeWhitespace(str) {
  return str.replace(/\s+/g, ' ').trim();
}

function canonicalize(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => k !== 'trace_id').sort();
    const out = {};
    for (const k of keys) {
      out[k] = canonicalize(value[k]);
    }
    return out;
  }
  if (typeof value === 'string') {
    return normalizeWhitespace(value);
  }
  return value;
}

function canonicalKey(tool, args) {
  const t = typeof tool === 'string' ? tool : String(tool);
  const a = canonicalize(args === undefined ? {} : args);
  return JSON.stringify({ tool: t, args: a });
}

// ---------- policy ----------

function evaluate(budgetTokens, rawSteps) {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return { decision: 'continue', reason: 'No steps taken yet; nothing to evaluate.' };
  }

  // Defensive: sort by step_number if present, to guarantee chronological order.
  const steps = rawSteps.slice().sort((a, b) => {
    const an = typeof a.step_number === 'number' ? a.step_number : 0;
    const bn = typeof b.step_number === 'number' ? b.step_number : 0;
    return an - bn;
  });

  // ---- budget check ----
  let total = 0;
  for (const s of steps) {
    total += toNumber(s.tokens_used);
  }
  const budget = toNumber(budgetTokens);
  if (total >= budget) {
    return {
      decision: 'halt',
      reason: `Cumulative tokens_used (${total}) has reached the budget (${budget}).`,
    };
  }

  // ---- build canonical keys for trailing steps ----
  const keys = steps.map((s) => canonicalKey(s.tool, s.args));

  // ---- rule 1: same tool + functionally identical args, 3+ in a row ----
  let runLen = 1;
  for (let i = keys.length - 1; i > 0; i--) {
    if (keys[i] === keys[i - 1]) {
      runLen++;
      if (runLen >= 3) {
        return {
          decision: 'halt',
          reason: 'The same tool call (same tool and functionally identical arguments) repeated 3 or more times in a row.',
        };
      }
    } else {
      break;
    }
  }

  // ---- rule 2: 2-step alternating cycle A,B,A,B,A,B for the trailing 6+ steps ----
  const n = keys.length;
  if (n >= 6) {
    const last6 = keys.slice(n - 6);
    const A = last6[0];
    const B = last6[1];
    if (A !== B) {
      let isCycle = true;
      for (let i = 0; i < 6; i++) {
        const expected = i % 2 === 0 ? A : B;
        if (last6[i] !== expected) {
          isCycle = false;
          break;
        }
      }
      if (isCycle) {
        return {
          decision: 'halt',
          reason: 'The trailing steps show a 2-step alternating cycle (A, B, A, B, A, B) with no distinguishing progress.',
        };
      }
    }
  }

  return { decision: 'continue', reason: 'Within budget and no repeated-call or cyclic-loop pattern detected in the trailing steps.' };
}

// ---------- endpoint ----------

app.post('/check', (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return respond(res, 'halt', 'Malformed request body.');
    }

    const { decision, reason } = evaluate(body.budget_tokens, body.steps);
    return respond(res, decision, reason);
  } catch (err) {
    return respond(res, 'halt', 'Error while evaluating run history.');
  }
});

app.get('/', (req, res) => res.send('Run budget and loop guard endpoint is running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
