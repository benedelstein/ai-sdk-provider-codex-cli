#!/usr/bin/env node

import { streamText } from 'ai';
import { createInterface } from 'readline';
import { createCodexAppServer } from '../../dist/index.js';

const appServer = createCodexAppServer({
  defaultSettings: { minCodexVersion: '0.105.0-alpha.0', idleTimeoutMs: 120000 },
});

const model = appServer('gpt-5.3-codex', {
  approvalPolicy: 'on-failure',
  sandboxPolicy: { type: 'readOnly' },
  threadMode: 'persistent',
});

const rl = createInterface({ input: process.stdin, output: process.stdout });

let threadId = undefined;

const ask = () =>
  rl.question('\nYou: ', async (input) => {
    const trimmed = input.trim();
    if (!trimmed || trimmed === 'exit' || trimmed === 'quit') {
      await appServer.close();
      rl.close();
      return;
    }

    try {
      const result = streamText({
        model,
        prompt: trimmed,
        ...(threadId && { providerOptions: { 'codex-app-server': { threadId } } }),
      });

      process.stdout.write('\n');
      let pendingInput;
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            process.stdout.write(part.text ?? part.textDelta ?? '');
            break;
          case 'tool-input-delta': {
            // Accumulate input so tool-call can show the command
            const raw = typeof part.delta === 'string' ? part.delta : JSON.stringify(part.delta);
            pendingInput = (pendingInput ?? '') + raw;
            break;
          }
          case 'tool-call': {
            let label = part.toolName;
            const inputStr = pendingInput ?? part.input ?? '{}';
            pendingInput = undefined;
            let parsedInput;
            try {
              parsedInput = JSON.parse(inputStr);
            } catch {
              /* ignore */
            }
            if (parsedInput?.command) label += `: ${parsedInput.command}`;
            else if (parsedInput?.tool) label += `: ${parsedInput.tool}`;
            else if (parsedInput?.query) label += `: ${parsedInput.query}`;
            process.stdout.write(`\n[${label}]\n`);
            if (part.toolName === 'update_plan' && Array.isArray(parsedInput?.plan)) {
              const statusIcon = { completed: '✓', inProgress: '…', pending: '○' };
              for (const step of parsedInput.plan) {
                const icon = statusIcon[step.status] ?? '?';
                process.stdout.write(`  ${icon} ${step.step}\n`);
              }
            }
            break;
          }
          case 'tool-result': {
            const r = part.result;
            if (process.env.CODEX_DEBUG_NOTIFICATIONS) {
              process.stderr.write(
                `[tool-result] toolName=${part.toolName} result=${String(JSON.stringify(r)).slice(0, 200)} meta=${String(JSON.stringify(part.providerMetadata)).slice(0, 200)}\n`,
              );
            }
            if (r?.type === 'output-delta') {
              process.stdout.write(r.delta ?? '');
            } else if (part.toolName !== 'update_plan') {
              const payload = r ?? part.providerMetadata?.['codex-app-server'];
              const exitCode = payload?.exitCode;
              const aggregated = payload?.aggregatedOutput;
              if (typeof exitCode === 'number') {
                process.stdout.write(`[exit: ${exitCode}]\n`);
              } else if (aggregated) {
                process.stdout.write(`${aggregated}\n`);
              }
            }
            break;
          }
          case 'reasoning':
            process.stdout.write(`[thinking: ${part.text}]\n`);
            break;
          case 'finish':
            threadId ??= part.providerMetadata?.['codex-app-server']?.threadId;
            break;
        }
      }
      process.stdout.write('\n');
    } catch (err) {
      console.error('Error:', err.message);
    }

    ask();
  });

console.log('Codex REPL — type "exit" to quit\n');
ask();
