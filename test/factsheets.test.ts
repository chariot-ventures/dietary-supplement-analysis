import { describe, expect, it } from 'vitest';
import { updatedDate } from '../scripts/check-factsheets.js';

describe('fact sheet date parsing', () => {
  it('reads ODS and NCCIH "Updated" dates', () => {
    expect(updatedDate('<p>Updated: <span>June 2, 2022</span></p>')).toBe('2022-06-02');
    expect(updatedDate('Last Updated: February 2025 ...')).toBe('2025-02-01');
    expect(updatedDate('<div>Last Updated: February 12, 2025</div>')).toBe('2025-02-12');
    expect(updatedDate('no date here')).toBeNull();
  });
});
