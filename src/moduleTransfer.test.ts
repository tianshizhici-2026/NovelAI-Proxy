import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportArtistClipboard, exportModuleSelection, importArtistClipboard, importModuleSelection } from './moduleTransfer';
import type { SelectedPrompt } from '../shared/prompts';
test('artist clipboard text preserves known/unknown order, quoted numeric names, groups and signed weights', () => {
  const selected: SelectedPrompt[] = [
    { id: 'a', category: 'artist', prompt: 'artist:docy520', weight: 0.8 },
    { id: 'b', category: 'artist', prompt: 'artist:unknown520', weight: -0.3 },
    { id: 'c', category: 'artist', prompt: 'artist:first, artist:second', weight: 1.2 },
    { id: 'q', category: 'quality', prompt: 'masterpiece', weight: 0.8 },
  ];
  const library = [
    { id: 'docy-new', category: 'artist' as const, name: 'Docy', prompt: 'artist:docy520', url: 'https://example.com' },
    { id: 'group-new', category: 'artist' as const, name: 'Group', prompt: 'artist:first, artist:second', url: 'https://example.com' },
  ];
  const text = exportArtistClipboard(selected);
  assert.equal(text, '0.8::artist:"docy520"::, -0.3::artist:"unknown520"::, 1.2::artist:first, artist:second::');
  const items = importArtistClipboard(text, library);
  assert.deepEqual(items.map(item => item.weight), [0.8, -0.3, 1.2]);
  assert.equal(items[0].id, 'docy-new'); assert.equal(items[2].id, 'group-new');
  assert.ok(items[1].prompt.includes('unknown520'));
  assert.equal(importArtistClipboard('docy520', library)[0].id, 'docy-new');
  assert.equal(importArtistClipboard(exportModuleSelection('artist', selected), library).length, 3);
  assert.throws(() => importArtistClipboard('', library), /没有画师串/);
  assert.throws(() => importArtistClipboard('9'.repeat(310) + '::artist:a::', library), /有限数字/);
});

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
