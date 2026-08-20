// Minimal QR Code generator — byte mode, automatic version/ECC-block handling
// and mask selection. Ported/condensed from Nayuki's public-domain
// "QR Code generator" (https://www.nayuki.io/page/qr-code-generator-library).
//
// Self-contained (no dependencies) so an installed/offline PWA can still render
// a shareable QR. `encodeText(text, ecl)` returns { size, modules } where
// `modules` is a size×size array of booleans (true = dark).

const ECC = { L: 0, M: 1, Q: 2, H: 3 }

// Number of error-correction codewords per block, indexed [ecl][version].
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
]

// Number of error-correction blocks, indexed [ecl][version].
const NUM_ECC_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
]

// ── GF(256) arithmetic for Reed–Solomon ─────────────────────────────────────
const GF_EXP = new Array(256)
const GF_LOG = new Array(256)
;(() => {
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
})()

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0
  return GF_EXP[(GF_LOG[a] + GF_LOG[b]) % 255]
}

function rsGenerator(degree) {
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i])
    }
    poly = next
  }
  return poly
}

function rsRemainder(data, degree) {
  const gen = rsGenerator(degree)
  const res = data.concat(new Array(degree).fill(0))
  for (let i = 0; i < data.length; i++) {
    const coef = res[i]
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], coef)
    }
  }
  return res.slice(data.length)
}

// ── Capacity helpers ────────────────────────────────────────────────────────
function numRawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (ver >= 7) result -= 36
  }
  return result
}

function numDataCodewords(ver, ecl) {
  return (
    Math.floor(numRawDataModules(ver) / 8) -
    ECC_CODEWORDS_PER_BLOCK[ecl][ver] * NUM_ECC_BLOCKS[ecl][ver]
  )
}

function charCountBits(ver) {
  return ver <= 9 ? 8 : 16
}

function alignmentPositions(ver) {
  if (ver === 1) return []
  const numAlign = Math.floor(ver / 7) + 2
  const step =
    ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2
  const size = ver * 4 + 17
  const result = [6]
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos)
  return result
}

// ── Public API ──────────────────────────────────────────────────────────────
export function encodeText(text, eclName = "M", forcedMask = null) {
  const ecl = ECC[eclName] ?? ECC.M
  const bytes = new TextEncoder().encode(text)

  // pick the smallest version that fits
  let ver = 1
  for (; ver <= 40; ver++) {
    const capacityBits = numDataCodewords(ver, ecl) * 8
    const needed = 4 + charCountBits(ver) + bytes.length * 8
    if (needed <= capacityBits) break
  }
  if (ver > 40) throw new Error("Data too long for a QR code")

  // build the bit stream
  const bits = []
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1)
  }
  push(0b0100, 4) // byte mode
  push(bytes.length, charCountBits(ver))
  for (const b of bytes) push(b, 8)

  const dataCapacity = numDataCodewords(ver, ecl) * 8
  push(0, Math.min(4, dataCapacity - bits.length)) // terminator
  while (bits.length % 8 !== 0) bits.push(0) // pad to byte

  const dataCodewords = []
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]
    dataCodewords.push(b)
  }
  for (let pad = 0xec; dataCodewords.length < numDataCodewords(ver, ecl); pad ^= 0xec ^ 0x11) {
    dataCodewords.push(pad)
  }

  const allCodewords = interleave(dataCodewords, ver, ecl)
  return buildMatrix(allCodewords, ver, ecl, forcedMask)
}

// Split into blocks, add EC per block, and interleave data + EC codewords.
function interleave(data, ver, ecl) {
  const numBlocks = NUM_ECC_BLOCKS[ecl][ver]
  const ecLen = ECC_CODEWORDS_PER_BLOCK[ecl][ver]
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8)
  const numShort = numBlocks - (rawCodewords % numBlocks)
  const shortLen = Math.floor(rawCodewords / numBlocks) - ecLen

  const blocks = []
  let k = 0
  for (let i = 0; i < numBlocks; i++) {
    const len = shortLen + (i < numShort ? 0 : 1)
    const dat = data.slice(k, k + len)
    k += len
    blocks.push({ data: dat, ec: rsRemainder(dat, ecLen) })
  }

  const result = []
  const maxData = shortLen + 1
  for (let i = 0; i < maxData; i++) {
    for (const blk of blocks) if (i < blk.data.length) result.push(blk.data[i])
  }
  for (let i = 0; i < ecLen; i++) {
    for (const blk of blocks) result.push(blk.ec[i])
  }
  return result
}

// ── Matrix construction ─────────────────────────────────────────────────────
function buildMatrix(codewords, ver, ecl, forcedMask = null) {
  const size = ver * 4 + 17
  const modules = Array.from({ length: size }, () => new Array(size).fill(false))
  const isFunc = Array.from({ length: size }, () => new Array(size).fill(false))

  const setFn = (r, c, dark) => {
    modules[r][c] = dark
    isFunc[r][c] = true
  }

  // finder patterns + separators
  const drawFinder = (cr, cc) => {
    for (let dr = -4; dr <= 4; dr++) {
      for (let dc = -4; dc <= 4; dc++) {
        const r = cr + dr
        const c = cc + dc
        if (r >= 0 && r < size && c >= 0 && c < size) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc))
          setFn(r, c, dist !== 2 && dist !== 4)
        }
      }
    }
  }
  drawFinder(3, 3)
  drawFinder(3, size - 4)
  drawFinder(size - 4, 3)

  // timing patterns
  for (let i = 0; i < size; i++) {
    if (!isFunc[6][i]) setFn(6, i, i % 2 === 0)
    if (!isFunc[i][6]) setFn(i, 6, i % 2 === 0)
  }

  // alignment patterns
  const positions = alignmentPositions(ver)
  const n = positions.length
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue
      const cr = positions[i]
      const cc = positions[j]
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          setFn(cr + dr, cc + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1)
        }
      }
    }
  }

  // dark module + reserve format info areas
  setFn(size - 8, 8, true)
  reserveFormat(size, setFn, isFunc)
  if (ver >= 7) drawVersion(ver, size, setFn)

  // place data bits in zigzag
  placeData(codewords, size, modules, isFunc)

  // choose the mask with the lowest penalty
  let bestMask = 0
  let bestPenalty = Infinity
  let bestModules = null
  for (let mask = 0; mask < 8; mask++) {
    if (forcedMask !== null && mask !== forcedMask) continue
    const trial = modules.map((row) => row.slice())
    applyMask(trial, isFunc, mask)
    drawFormat(trial, isFunc, ecl, mask)
    const p = penalty(trial)
    if (p < bestPenalty) {
      bestPenalty = p
      bestMask = mask
      bestModules = trial
    }
  }

  return { size, modules: bestModules, version: ver, mask: bestMask }
}

function reserveFormat(size, setFn, isFunc) {
  for (let i = 0; i <= 8; i++) {
    if (!isFunc[8][i]) setFn(8, i, false)
    if (!isFunc[i][8]) setFn(i, 8, false)
  }
  for (let i = 0; i < 8; i++) {
    setFn(size - 1 - i, 8, false)
    setFn(8, size - 1 - i, false)
  }
}

function drawVersion(ver, size, setFn) {
  let rem = ver
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  const bits = ((ver << 12) | rem) >>> 0
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >>> i) & 1) === 1
    const a = size - 11 + (i % 3)
    const b = Math.floor(i / 3)
    setFn(a, b, bit)
    setFn(b, a, bit)
  }
}

function placeData(codewords, size, modules, isFunc) {
  let bitIndex = 0
  const totalBits = codewords.length * 8
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j
        const upward = ((right + 1) & 2) === 0
        const r = upward ? size - 1 - vert : vert
        if (!isFunc[r][c]) {
          let dark = false
          if (bitIndex < totalBits) {
            const cw = codewords[bitIndex >>> 3]
            dark = ((cw >>> (7 - (bitIndex & 7))) & 1) === 1
          }
          modules[r][c] = dark
          bitIndex++
        }
      }
    }
  }
}

function applyMask(modules, isFunc, mask) {
  const size = modules.length
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (isFunc[r][c]) continue
      let invert = false
      switch (mask) {
        case 0: invert = (r + c) % 2 === 0; break
        case 1: invert = r % 2 === 0; break
        case 2: invert = c % 3 === 0; break
        case 3: invert = (r + c) % 3 === 0; break
        case 4: invert = (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; break
        case 5: invert = ((r * c) % 2) + ((r * c) % 3) === 0; break
        case 6: invert = (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; break
        case 7: invert = (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; break
      }
      if (invert) modules[r][c] = !modules[r][c]
    }
  }
}

function drawFormat(modules, isFunc, ecl, mask) {
  const eclBits = [1, 0, 3, 2][ecl] // L,M,Q,H -> 01,00,11,10
  const data = (eclBits << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  const bits = (((data << 10) | rem) ^ 0x5412) >>> 0
  const size = modules.length

  const set = (r, c, bit) => {
    modules[r][c] = bit
  }
  // First copy (around the top-left finder).
  for (let i = 0; i <= 5; i++) set(i, 8, getBit(bits, i))
  set(7, 8, getBit(bits, 6))
  set(8, 8, getBit(bits, 7))
  set(8, 7, getBit(bits, 8))
  for (let i = 9; i < 15; i++) set(8, 14 - i, getBit(bits, i))

  // Second copy (along the bottom-left and top-right).
  for (let i = 0; i < 8; i++) set(8, size - 1 - i, getBit(bits, i))
  for (let i = 8; i < 15; i++) set(size - 15 + i, 8, getBit(bits, i))
  set(size - 8, 8, true) // always-dark module
  void isFunc
}

function getBit(x, i) {
  return ((x >>> i) & 1) === 1
}

// ── Penalty scoring (mask selection) ────────────────────────────────────────
function penalty(m) {
  const size = m.length
  let p = 0

  // rule 1: runs of 5+ same-color modules in rows and columns
  for (let r = 0; r < size; r++) {
    let run = 1
    for (let c = 1; c < size; c++) {
      if (m[r][c] === m[r][c - 1]) {
        run++
        if (run === 5) p += 3
        else if (run > 5) p += 1
      } else run = 1
    }
  }
  for (let c = 0; c < size; c++) {
    let run = 1
    for (let r = 1; r < size; r++) {
      if (m[r][c] === m[r - 1][c]) {
        run++
        if (run === 5) p += 3
        else if (run > 5) p += 1
      } else run = 1
    }
  }

  // rule 2: 2x2 blocks of the same color
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c]
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) p += 3
    }
  }

  // rule 3: finder-like patterns
  const pat1 = [true, false, true, true, true, false, true, false, false, false, false]
  const pat2 = [false, false, false, false, true, false, true, true, true, false, true]
  const matches = (r, c, dr, dc) => {
    let ok1 = true
    let ok2 = true
    for (let i = 0; i < 11; i++) {
      const rr = r + dr * i
      const cc = c + dc * i
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) return
      const v = m[rr][cc]
      if (v !== pat1[i]) ok1 = false
      if (v !== pat2[i]) ok2 = false
    }
    if (ok1) p += 40
    if (ok2) p += 40
  }
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      matches(r, c, 0, 1)
      matches(r, c, 1, 0)
    }
  }

  // rule 4: proportion of dark modules
  let dark = 0
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c]) dark++
  const total = size * size
  const percent = (dark * 100) / total
  const k = Math.floor(Math.abs(percent - 50) / 5)
  p += k * 10

  return p
}
