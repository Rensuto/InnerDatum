import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

describe('native map-space marker pipeline', () => {
  it('builds only the closed thirteen-file family and passes native-pixel QA', () => {
    const stage = mkdtempSync(join(tmpdir(), 'inner-datum-map-markers-'));
    try {
      const generated = execFileSync(
        'python',
        ['tools/gen_ui_assets.py', '--map-space-only', '--out-dir', stage],
        { cwd: REPO, encoding: 'utf8' },
      );
      expect(generated).toContain('13 UI assets generated');

      const checked = execFileSync('python', ['tools/check_map_markers.py', stage], {
        cwd: REPO,
        encoding: 'utf8',
      });
      expect(checked).toContain('PASS 13 native 64x64 map-space assets');
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });

  it('keeps cell marks on the cell blit and bodies on the natural-size blit', () => {
    const canvas = readFileSync(join(REPO, 'src/client/render/canvas.ts'), 'utf8');
    const cellFrom = canvas.indexOf('function blitCell(');
    const bodyFrom = canvas.indexOf('function blitSprite(', cellFrom);
    expect(cellFrom).toBeGreaterThan(-1);
    expect(bodyFrom).toBeGreaterThan(cellFrom);

    const cellBlit = canvas.slice(cellFrom, bodyFrom);
    expect(cellBlit).toContain('drawImage(sprite.image, cellX, cellY, TILE_PX, TILE_PX)');
    expect(cellBlit).not.toContain('sprite.w');
    expect(cellBlit).not.toContain('sprite.h');

    const bodyBlit = canvas.slice(bodyFrom, canvas.indexOf('\n  function ', bodyFrom + 1));
    expect(bodyBlit).toContain('(TILE_PX - sprite.w) / 2');
    expect(bodyBlit).toContain('TILE_PX - sprite.h');
  });
});
