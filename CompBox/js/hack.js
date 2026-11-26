/* hack.js — Hack assembler + CPU emulator (works in browser and Node) */
(function (root) {
  'use strict';

  const COMP = {
    '0': '0101010', '1': '0111111', '-1': '0111010', 'D': '0001100', 'A': '0110000',
    '!D': '0001101', '!A': '0110001', '-D': '0001111', '-A': '0110011', 'D+1': '0011111',
    'A+1': '0110111', 'D-1': '0001110', 'A-1': '0110010', 'D+A': '0000010', 'D-A': '0010011',
    'A-D': '0000111', 'D&A': '0000000', 'D|A': '0010101',
    'M': '1110000', '!M': '1110001', '-M': '1110011', 'M+1': '1110111', 'M-1': '1110010',
    'D+M': '1000010', 'D-M': '1010011', 'M-D': '1000111', 'D&M': '1000000', 'D|M': '1010101'
  };
  const JUMP = { '': '000', JGT: '001', JEQ: '010', JGE: '011', JLT: '100', JNE: '101', JLE: '110', JMP: '111' };
  const PREDEF = { SP: 0, LCL: 1, ARG: 2, THIS: 3, THAT: 4, SCREEN: 16384, KBD: 24576 };
  for (let i = 0; i < 16; i++) PREDEF['R' + i] = i;

  const COMP_REV = {};
  Object.keys(COMP).forEach(k => { COMP_REV[COMP[k]] = k; });
  const DEST_REV = ['', 'M', 'D', 'MD', 'A', 'AM', 'AD', 'AMD'];
  const JUMP_REV = ['', 'JGT', 'JEQ', 'JGE', 'JLT', 'JNE', 'JLE', 'JMP'];

  const clean = line => line.split('//')[0].replace(/\s+/g, '');
  const isSymbol = s => /^[A-Za-z_.$:][A-Za-z0-9_.$:]*$/.test(s);

  function cInstruction(text) {
    let dest = '', comp = text, jump = '';
    if (comp.includes('=')) { const i = comp.indexOf('='); dest = comp.slice(0, i); comp = comp.slice(i + 1); }
    if (comp.includes(';')) { const i = comp.indexOf(';'); jump = comp.slice(i + 1); comp = comp.slice(0, i); }
    if (!(comp in COMP)) return { err: `invalid instruction '${text}' (unknown computation '${comp}')` };
    if (!(jump in JUMP)) return { err: `invalid instruction '${text}' (unknown jump '${jump}')` };
    let d = '000';
    if (dest !== '') {
      if ([...dest].some(c => 'ADM'.indexOf(c) < 0) || new Set(dest).size !== dest.length)
        return { err: `invalid instruction '${text}' (unknown destination '${dest}')` };
      d = (dest.includes('A') ? '1' : '0') + (dest.includes('D') ? '1' : '0') + (dest.includes('M') ? '1' : '0');
    }
    return { bin: '111' + COMP[comp] + d + JUMP[jump] };
  }

  /* Two-pass assembler.
     errors   -> [{line, msg}]  (no machine code should be used when non-empty)
     warnings -> [{line, msg}]  (duplicate labels: first definition is kept) */
  function assemble(source) {
    const lines = source.split(/\r?\n/);
    const errors = [], warnings = [];
    const symbols = Object.assign({}, PREDEF);
    const declared = {};
    const program = [];          // {line, text, raw}
    const rows = [];             // listing rows in source order

    lines.forEach((raw, idx) => {
      const line = idx + 1, text = clean(raw);
      if (text === '') return;
      if (text[0] === '(') {
        const name = text.slice(1, -1);
        if (text[text.length - 1] !== ')' || !isSymbol(name)) {
          errors.push({ line, msg: `invalid label '${text}'` });
          return;
        }
        if (name in declared) {
          warnings.push({ line, msg: `duplicate label '(${name})' — already declared at line ${declared[name].line} (ROM ${declared[name].addr}); keeping the first definition` });
        } else {
          declared[name] = { line, addr: program.length };
          symbols[name] = program.length;
        }
        rows.push({ kind: 'label', line, name, addr: program.length });
      } else {
        program.push({ line, text });
      }
    });

    const binary = [];
    let nextVar = 16;
    const progRows = [];
    program.forEach((p, addr) => {
      let bin = null;
      if (p.text[0] === '@') {
        const v = p.text.slice(1);
        let n = null;
        if (/^\d+$/.test(v)) {
          n = parseInt(v, 10);
          if (n > 32767) { errors.push({ line: p.line, msg: `number too large in '${p.text}' (max 32767)` }); n = null; }
        } else if (isSymbol(v)) {
          if (!(v in symbols)) symbols[v] = nextVar++;
          n = symbols[v];
        } else {
          errors.push({ line: p.line, msg: `invalid A-instruction '${p.text}'` });
        }
        if (n !== null) bin = n.toString(2).padStart(16, '0');
      } else {
        const r = cInstruction(p.text);
        if (r.err) errors.push({ line: p.line, msg: r.err }); else bin = r.bin;
      }
      if (bin !== null) binary.push(bin);
      progRows.push({ kind: 'ins', line: p.line, addr, text: p.text, bin });
    });

    errors.sort((a, b) => a.line - b.line);
    const listing = rows.concat(progRows).sort((a, b) => a.line - b.line);
    return { binary, errors, warnings, symbols, listing, count: program.length };
  }

  function disassemble(ins) {
    if (!(ins & 0x8000)) return '@' + (ins & 0x7FFF);
    const comp = COMP_REV[((ins >> 6) & 0x7F).toString(2).padStart(7, '0')] || '?';
    const d = DEST_REV[(ins >> 3) & 7], j = JUMP_REV[ins & 7];
    return (d ? d + '=' : '') + comp + (j ? ';' + j : '');
  }

  function decode(ins) {
    const bits = ins.toString(2).padStart(16, '0');
    if (!(ins & 0x8000)) return { type: 'A', bits, value: ins & 0x7FFF, text: '@' + (ins & 0x7FFF) };
    return {
      type: 'C', bits, a: (ins >> 12) & 1, comp: bits.slice(4, 10), dest: bits.slice(10, 13), jump: bits.slice(13),
      compName: COMP_REV[((ins >> 6) & 0x7F).toString(2).padStart(7, '0')] || '(invalid)',
      destName: DEST_REV[(ins >> 3) & 7], jumpName: JUMP_REV[ins & 7], text: disassemble(ins)
    };
  }

  /* Hack CPU + memory (RAM 0..16383, screen 16384..24575, keyboard 24576) */
  class Hack {
    constructor() {
      this.rom = new Uint16Array(32768);
      this.ram = new Int16Array(24577);
      this.romLen = 0;
      this.reset();
    }
    load(binary) {
      this.rom.fill(0);
      binary.forEach((b, i) => { this.rom[i] = parseInt(b, 2); });
      this.romLen = binary.length;
      this.reset();
    }
    reset() {
      this.ram.fill(0); this.A = 0; this.D = 0; this.pc = 0; this.cycles = 0; this.screenDirty = true;
    }
    step() { this.run(1); }
    run(n) {
      const rom = this.rom, ram = this.ram;
      let A = this.A, D = this.D, pc = this.pc, dirty = false;
      this.cycles += n;
      for (; n > 0; n--) {
        const ins = rom[pc];
        if ((ins & 0x8000) === 0) { A = ins; pc = (pc + 1) & 0x7FFF; continue; }
        const addr = A & 0x7FFF;
        const M = addr <= 24576 ? ram[addr] : 0;
        const c = (ins >> 6) & 0x3F;
        let x = D, y = (ins & 0x1000) ? M : A;
        if (c & 32) x = 0;
        if (c & 16) x = ~x;
        if (c & 8) y = 0;
        if (c & 4) y = ~y;
        let o = (c & 2) ? (x + y) : (x & y);
        if (c & 1) o = ~o;
        o = (o << 16) >> 16;
        const d = (ins >> 3) & 7, j = ins & 7;
        if ((d & 1) && addr < 24576) { ram[addr] = o; if (addr >= 16384) dirty = true; }
        if (d & 2) D = o;
        const jump = ((j & 4) && o < 0) || ((j & 2) && o === 0) || ((j & 1) && o > 0);
        const target = addr;               // jump uses the A value from before this instruction
        if (d & 4) A = o;
        pc = jump ? target : (pc + 1) & 0x7FFF;
      }
      this.A = A; this.D = D; this.pc = pc;
      if (dirty) this.screenDirty = true;
    }
    setKey(k) { this.ram[24576] = k; }
  }

  const api = { assemble, disassemble, decode, Hack, PREDEF, clean };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.HackLib = api;
})(typeof self !== 'undefined' ? self : this);
