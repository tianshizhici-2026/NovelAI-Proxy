import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportModuleSelection, importModuleSelection } from './moduleTransfer';
import type { SelectedPrompt } from '../shared/prompts';

test('category exports preserve selected order and signed weights and rebind portable numeric artist names', () => {
  const selected: SelectedPrompt[] = [
    { id: 'old-a', category: 'artist', prompt: 'artist:"docy520"', weight: 0.8 },
    { id: 'style', category: 'quality', prompt: 'artist collaboration', weight: -5 },
    { id: 'old-b', category: 'artist', prompt: 'artist:example', weight: 1.2 },
  ];
  const text = exportModuleSelection('artist', selected);
  const data = JSON.parse(text);
  assert.deepEqual(data.modules, [{ prompt: 'artist:"docy520"', weight: 0.8 }, { prompt: 'artist:example', weight: 1.2 }]);
  const imported = importModuleSelection(text, 'artist', [{ id: 'local-id', category: 'artist', name: 'Docy', prompt: 'artist:docy520', url: 'https://example.com' }]);
  assert.equal(imported[0].id, 'local-id'); assert.equal(imported[0].prompt, 'artist:docy520');
  assert.equal(imported[1].prompt, 'artist:example'); assert.equal(imported[1].weight, 1.2);
  assert.notEqual(imported[1].id, 'old-b');
  assert.equal(importModuleSelection(exportModuleSelection('quality', selected), 'quality', [])[0].weight, -5);
});
test('imports round fractional weights, collapse duplicates and reject wrong categories or malformed files', () => {
  const file = (modules: unknown[]) => JSON.stringify({ version: 1, category: 'quality', modules });
  const imported = importModuleSelection('\uFEFF' + file([{ prompt: 'year 2025', weight: 0.35 }, { prompt: 'year 2025', weight: 2 }, { prompt: 'hat', weight: -0.035 }]), 'quality', []);
  assert.deepEqual(imported.map(({ prompt, weight }) => ({ prompt, weight })), [{ prompt: 'year 2025', weight: 0.4 }, { prompt: 'hat', weight: -0.1 }]);
  assert.throws(() => importModuleSelection(file([]), 'artist', []), /质量风格/);
  for (const bad of ['invalid', '[]', file([{ prompt: '', weight: 1 }]), file([{ prompt: 'hat', weight: '1' }]), file(Array.from({ length: 101 }, () => ({ prompt: 'hat', weight: 1 })))])
    assert.throws(() => importModuleSelection(bad, 'quality', []));
});
