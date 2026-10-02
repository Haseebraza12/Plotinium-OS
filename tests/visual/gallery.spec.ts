/**
 * Screenshots every ui/gallery page in both themes and compares them with the committed
 * references in tests/visual/__screenshots__/visual/ (PLT-ID-06: one token set, light and dark).
 *
 *   pnpm --filter @plotinium/ui gallery          (serves http://localhost:4718)
 *   PLOTINIUM_GALLERY_URL=http://localhost:4718 pnpm exec playwright test -c tests/playwright.config.ts --project visual
 *   … --update-snapshots                         (after an intended visual change, reviewed in the PR)
 *
 * Skipped without PLOTINIUM_GALLERY_URL. References are platform-specific; they are recorded on
 * the CI runner image (ubuntu-24.04, Chrome stable) so local runs on other systems may differ.
 */
import { expect, test } from '@playwright/test';

import { galleryUrl } from '../support/env.ts';

import {
  GALLERY_THEMES,
  galleryPages,
  MIN_HEIGHT,
  openGalleryPage,
  snapshotName,
  VIEWPORT_WIDTH,
} from './gallery.ts';

const base = galleryUrl();

test.describe('ui gallery in both themes', () => {
  test.skip(
    base === undefined,
    'set PLOTINIUM_GALLERY_URL to the served ui/gallery (pnpm --filter @plotinium/ui gallery)',
  );

  for (const id of galleryPages()) {
    for (const theme of GALLERY_THEMES) {
      test(`PLT-ID-06 the ${id} gallery page matches its ${theme} reference screenshot`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: VIEWPORT_WIDTH, height: MIN_HEIGHT });
        await openGalleryPage(page, base as string, id, theme);
        await expect(page).toHaveScreenshot(snapshotName(id, theme), {
          fullPage: true,
          animations: 'disabled',
          caret: 'hide',
        });
      });
    }
  }
});
