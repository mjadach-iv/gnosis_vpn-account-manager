// Custom interactive menu prompt.
//
// Like a basic `select`, but Del/Backspace on a deletable choice resolves with
// an { action: 'delete' } result so the caller can confirm + remove it, and `r`
// on a deletable choice resolves with { action: 'rename' }. Enter resolves with
// { action: 'select' }.
//
// choices: [{ name, value, deletable }]
// resolves: { action: 'select' | 'delete' | 'rename', value, name, deletable }

import {
  createPrompt,
  useState,
  useKeypress,
  usePrefix,
  isEnterKey,
  isUpKey,
  isDownKey,
  isBackspaceKey,
} from '@inquirer/core';

export const accountMenu = createPrompt((config, done) => {
  const { message, choices } = config;
  const [status, setStatus] = useState('idle');
  const [active, setActive] = useState(0);
  const prefix = usePrefix({ status });

  useKeypress((key) => {
    if (status !== 'idle') return;

    if (isEnterKey(key)) {
      setStatus('done');
      done({ action: 'select', ...choices[active] });
    } else if (isUpKey(key)) {
      setActive((active - 1 + choices.length) % choices.length);
    } else if (isDownKey(key)) {
      setActive((active + 1) % choices.length);
    } else if (isBackspaceKey(key) || key.name === 'delete') {
      const choice = choices[active];
      if (choice.deletable) {
        setStatus('done');
        done({ action: 'delete', ...choice });
      }
    } else if (key.name === 'r') {
      const choice = choices[active];
      if (choice.deletable) {
        setStatus('done');
        done({ action: 'rename', ...choice });
      }
    }
  });

  if (status === 'done') {
    return `${prefix} ${message}`;
  }

  const list = choices
    .map((c, i) => (i === active ? `\x1b[36m❯ ${c.name}\x1b[0m` : `  ${c.name}`))
    .join('\n');
  const help =
    '\x1b[2m(↑/↓ move · Enter select · r rename · Del/Backspace remove a saved account)\x1b[0m';

  return `${prefix} ${message}\n${list}\n\n${help}`;
});
