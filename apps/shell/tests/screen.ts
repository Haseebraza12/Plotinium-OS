/**
 * Test-only terminal emulator: enough of xterm for the line editor's output (text with pending
 * wrap, CR, LF, cursor moves A/B/C/D/G/H, erase J/K, SGR and private modes ignored).
 */
export class Screen {
  private rows: string[][] = [[]];
  private row = 0;
  private col = 0;
  private wrapPending = false;
  readonly cols: number;

  constructor(cols = 80) {
    this.cols = cols;
  }

  private line(r: number): string[] {
    while (this.rows.length <= r) this.rows.push([]);
    return this.rows[r] ?? [];
  }

  private put(ch: string): void {
    if (this.wrapPending) {
      this.row++;
      this.col = 0;
      this.wrapPending = false;
    }
    const l = this.line(this.row);
    while (l.length < this.col) l.push(' ');
    l[this.col] = ch;
    if (this.col === this.cols - 1) this.wrapPending = true;
    else this.col++;
  }

  private csi(params: string, final: string): void {
    const nums = params
      .replace(/^\?/, '')
      .split(';')
      .map((p) => (p === '' ? NaN : Number(p)));
    const n = Number.isNaN(nums[0] ?? NaN) ? 1 : (nums[0] ?? 1);
    this.wrapPending = false;
    switch (final) {
      case 'A':
        this.row = Math.max(0, this.row - n);
        break;
      case 'B':
        this.row += n;
        break;
      case 'C':
        this.col = Math.min(this.cols - 1, this.col + n);
        break;
      case 'D':
        this.col = Math.max(0, this.col - n);
        break;
      case 'G':
        this.col = Math.min(this.cols - 1, n - 1);
        break;
      case 'H':
        this.row = Number.isNaN(nums[0] ?? NaN) ? 0 : (nums[0] ?? 1) - 1;
        this.col = Number.isNaN(nums[1] ?? NaN) ? 0 : (nums[1] ?? 1) - 1;
        break;
      case 'J':
        if (params === '2') {
          this.rows = [[]];
        } else {
          this.line(this.row).length = Math.min(this.line(this.row).length, this.col);
          this.rows.length = Math.min(this.rows.length, this.row + 1);
        }
        break;
      case 'K':
        this.line(this.row).length = Math.min(this.line(this.row).length, this.col);
        break;
      default:
        break;
    }
  }

  write(text: string): void {
    let i = 0;
    while (i < text.length) {
      const c = text[i] ?? '';
      if (c === '\x1b') {
        // eslint-disable-next-line no-control-regex -- parsing escape sequences
        const m = /^\x1b\[([0-9;?]*)([\x40-\x7e])/.exec(text.slice(i));
        if (m) {
          this.csi(m[1] ?? '', m[2] ?? '');
          i += m[0].length;
        } else {
          i += 2;
        }
        continue;
      }
      if (c === '\r') {
        this.col = 0;
        this.wrapPending = false;
      } else if (c === '\n') {
        this.row++;
        this.wrapPending = false;
      } else if (c === '\x07') {
        // bell
      } else {
        this.put(c);
      }
      i++;
    }
  }

  lines(): string[] {
    return this.rows.map((r) => r.join('').trimEnd());
  }

  /** The screen as text, trailing blank lines removed. */
  text(): string {
    const lines = this.lines();
    while (lines.length > 0 && lines.at(-1) === '') lines.pop();
    return lines.join('\n');
  }

  cursor(): { row: number; col: number } {
    return { row: this.row, col: this.col };
  }
}
