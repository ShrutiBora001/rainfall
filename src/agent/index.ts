import Anthropic from '@anthropic-ai/sdk';
import { RainfallService, usd } from '../core/service.js';

/**
 * The buyer agent.
 *
 * It does not get told "buy the phone". It is given a goal and a set of tools,
 * and has to work out whether it can afford the thing -- which, on Rainfall,
 * is a question about standing rather than balance. The interesting failure it
 * can hit is being declined for insufficient credit and having to reason about
 * what would change that.
 */

const MODEL = 'claude-opus-5';

const SYSTEM = `You are a procurement agent with your own credit line, transacting autonomously.

You have no cash. You buy on installment credit: an underwriter on Monad assesses
each purchase, a card is issued scoped to that one merchant and amount, and you
repay over several installments. Your repayment history determines how much
collateral your owner must lock behind you — repay reliably and that collateral
is released.

Work through your tools rather than assuming. Check what a purchase would cost
you before committing to it. If a purchase is declined, read the reason and say
plainly what would need to change; do not retry the identical request.

Keep responses to one or two sentences. State what you did and what happened.`;

const tools: Anthropic.Tool[] = [
  {
    name: 'search_catalog',
    description:
      'List the items available to buy, with price, merchant, and merchant category code. Call this first when you do not already know what is for sale.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'check_credit',
    description:
      'Ask the underwriter what terms a given item would get: approved or declined, the reason, the credit limit, how much collateral would be required, and the installment count. Call this before purchasing so you know the terms you are accepting.',
    input_schema: {
      type: 'object',
      properties: { sku: { type: 'string', description: 'Item sku, e.g. "phone"' } },
      required: ['sku'],
    },
  },
  {
    name: 'purchase',
    description:
      'Buy an item on installment credit. Issues a scoped card and opens the obligation on-chain. Fails if the underwriter declines. Optionally choose how many installments to spread it over (2-12); omit to take the default plan.',
    input_schema: {
      type: 'object',
      properties: {
        sku: { type: 'string' },
        installments: {
          type: 'integer',
          description: 'Number of installments, 2 to 12. A longer plan lowers each payment but does not raise your credit limit.',
        },
      },
      required: ['sku'],
    },
  },
  {
    name: 'list_obligations',
    description:
      'List your open obligations: what you owe, how many installments you have paid, and when the next one is due.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'pay_installment',
    description:
      'Pay the next installment on one of your obligations. Paying on time raises your standing and releases collateral.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Obligation id' } },
      required: ['id'],
    },
  },
];

async function runTool(
  svc: RainfallService,
  name: string,
  input: any,
): Promise<string> {
  switch (name) {
    case 'search_catalog':
      return JSON.stringify(
        svc.catalog().map((i) => ({
          sku: i.sku,
          label: i.label,
          price: usd(i.cents),
          merchant: i.merchant,
          mcc: i.mcc,
        })),
      );

    case 'check_credit': {
      const q = await svc.quote(input.sku);
      return JSON.stringify({
        item: q.item.label,
        price: usd(q.item.cents),
        approved: q.approved,
        reason: q.reason,
        creditLimit: usd(Number(q.creditLimit / 10_000n)),
        requiredCollateralPct: q.requiredCollateralBps / 100,
        installments: q.installments,
        aprPct: q.aprBps / 100,
      });
    }

    case 'purchase': {
      const r = await svc.buy(input.sku, input.installments);
      return JSON.stringify(
        r.approved
          ? { purchased: true, obligationId: r.id }
          : { purchased: false, reason: r.reason },
      );
    }

    case 'list_obligations': {
      const s = await svc.state();
      return JSON.stringify(
        s.agreements.map((a) => ({
          id: a.id,
          status: a.status,
          paid: `${a.paid}/${a.installments}`,
          installment: usd(Number(BigInt(a.installmentAmount) / 10_000n)),
          overdue: a.overdue,
        })),
      );
    }

    case 'pay_installment':
      await svc.pay(Number(input.id));
      return JSON.stringify({ paid: true, id: input.id });

    default:
      return JSON.stringify({ error: `unknown tool ${name}` });
  }
}

export interface AgentTurn {
  text: string;
  toolCalls: string[];
}

/**
 * One agent turn: give it a goal, let it work until it stops calling tools.
 * A manual loop rather than the SDK tool runner -- the demo needs the tool
 * sequence to be inspectable and the control flow predictable on stage.
 */
export async function runAgent(
  svc: RainfallService,
  goal: string,
  opts: { maxTurns?: number } = {},
): Promise<AgentTurn> {
  const client = new Anthropic();
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: goal }];
  const toolCalls: string[] = [];
  const maxTurns = opts.maxTurns ?? 12;

  svc.say('agent', `goal: ${goal}`);

  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: SYSTEM,
      tools,
      messages,
    });

    if (res.stop_reason === 'refusal') {
      svc.say('agent', 'model declined the request');
      return { text: 'The model declined this request.', toolCalls };
    }

    // Append the full content, not just text -- thinking and tool_use blocks
    // must survive into the next request.
    messages.push({ role: 'assistant', content: res.content });

    const uses = res.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    const said = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text.trim())
      .filter(Boolean)
      .join(' ');
    if (said) svc.say('agent', said);

    if (uses.length === 0) return { text: said, toolCalls };

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const u of uses) {
      toolCalls.push(u.name);
      svc.say('tool', `${u.name}(${JSON.stringify(u.input)})`);
      try {
        results.push({
          type: 'tool_result',
          tool_use_id: u.id,
          content: await runTool(svc, u.name, u.input),
        });
      } catch (e) {
        results.push({
          type: 'tool_result',
          tool_use_id: u.id,
          content: `Error: ${(e as Error).message}`,
          is_error: true,
        });
      }
    }
    // All results in a single user message — splitting them trains the model
    // out of parallel tool calls.
    messages.push({ role: 'user', content: results });
  }

  svc.say('warn', `agent hit the ${maxTurns}-turn cap`);
  return { text: `Stopped after ${maxTurns} turns.`, toolCalls };
}

/**
 * Credential-free fallback. If the API is unreachable mid-demo, the agent's
 * *decisions* still run against the same tools -- only the reasoning is
 * hard-coded. Say so on stage if you use it; do not pass it off as the model.
 */
export async function runScriptedAgent(
  svc: RainfallService,
  sku: string,
  installments?: number,
): Promise<AgentTurn> {
  const toolCalls: string[] = ['search_catalog', 'check_credit'];
  svc.say('agent', `[scripted] evaluating ${sku}`);
  const q = await svc.quote(sku);
  if (!q.approved) {
    svc.say('agent', `[scripted] declined — ${q.reason}`);
    return { text: `Declined: ${q.reason}`, toolCalls };
  }
  toolCalls.push('purchase');
  const r = await svc.buy(sku, installments);
  const n = installments ?? q.installments;
  return {
    text: r.approved ? `Bought ${q.item.label} on ${n} installments.` : r.reason,
    toolCalls,
  };
}

export async function agentAvailable(): Promise<boolean> {
  try {
    const client = new Anthropic();
    await client.messages.create({
      model: MODEL,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'ok' }],
    });
    return true;
  } catch {
    return false;
  }
}
