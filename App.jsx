import { useState, useEffect, useCallback, useRef } from "react";

// ==================== CONSTANTS ====================
const COLORS = ["🔴", "🟡", "🟢", "🔵", "🟠", "🟣", "⚫"];
const COLOR_BG = ["#e74c3c","#f1c40f","#2ecc71","#3498db","#e67e22","#9b59b6","#34495e"];
const COLOR_LIGHT = ["#fadbd8","#fef9e7","#d5f5e3","#d6eaf8","#fdebd0","#e8daef","#d5d8dc"];
const SCORING = [0, 1, 3, 6, 10, 15, 21, 21]; // 6枚以上は21点

function buildDeck(numColors) {
const deck = [];
for (let col = 0; col < numColors; col++) for (let i = 0; i < 9; i++) deck.push({ type: "color", color: col });
for (let i = 0; i < 3; i++) deck.push({ type: "joker" });
for (let i = 0; i < 3; i++) deck.push({ type: "plus2" });
for (let i = deck.length - 1; i > 0; i–) {
const j = Math.floor(Math.random() * (i + 1));
[deck[i], deck[j]] = [deck[j], deck[i]];
}
// Insert end card 15 cards from the bottom
const endPos = Math.max(0, deck.length - 15);
deck.splice(endPos, 0, { type: "end" });
return deck;
}

function getScore(counts, jokers = 0) {
// Allocate each joker to the color that gives the most marginal gain
const c = […counts];
for (let j = 0; j < jokers; j++) {
// Find which of the top-3 colors benefits most from +1
const sorted = c.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
let bestGain = -Infinity, bestIdx = sorted[0].i;
sorted.slice(0, 3).forEach(({ v, i }) => {
const gain = SCORING[Math.min(v + 1, 6)] - SCORING[Math.min(v, 6)];
if (gain > bestGain) { bestGain = gain; bestIdx = i; }
});
c[bestIdx]++;
}
const sorted = […c].sort((a, b) => b - a);
let score = 0;
sorted.forEach((v, i) => {
const s = SCORING[Math.min(v, 6)];
score += i < 3 ? s : -s;
});
return score;
}

function countColors(hand) {
const counts = Array(7).fill(0);
hand.forEach(c => { if (c.type === "color") counts[c.color]++; });
return counts;
}

function countJokers(hand) {
return hand.filter(c => c.type === "joker").length;
}

// ==================== CPU AI ====================
// Returns { action: "draw"|"take", rowIndex? }
function cpuDecide(g, playerIndex) {
const player = g.players[playerIndex];
const counts = countColors(player.hand);
const myColorCount = counts.filter(c => c > 0).length;
const deckRatio = g.lastRound ? 0 : g.deck.length / 67;

// Simulate score gain if player takes a given row
const myJokers = countJokers(player.hand);

function scoreGainForRow(row) {
const newCounts = […counts];
let bonus = 0;
let newJokers = myJokers;

for (const card of row) {
  if (card.type === "plus2") { bonus += 2; continue; }
  if (card.type === "joker") { newJokers++; continue; }
  newCounts[card.color]++;
}

const before = getScore(counts, myJokers);
const after = getScore(newCounts, newJokers) + bonus;
const gain = after - before;

// Penalize opening colors beyond 3 that hurt score
const totalColorsAfter = newCounts.filter(v => v > 0).length;
const extraColorPenalty = Math.max(0, totalColorsAfter - 3) * 2;

return gain - extraColorPenalty;

}

const availableRows = g.rows
.map((row, i) => ({ row, i }))
.filter(({ i }) => !g.rowTaken[i] && g.rows[i].length > 0);

if (availableRows.length === 0) return { action: "draw" };

const scoredRows = availableRows
.map(({ row, i }) => ({ i, gain: scoreGainForRow(row), len: row.length }))
.sort((a, b) => b.gain - a.gain);

const bestRow = scoredRows[0];

const allRowsFull = g.rows.every((r, i) => g.rowTaken[i] || r.length >= (g.rowMaxCards?.[i] ?? 3));
if (allRowsFull || g.lastRound) {
return { action: "take", rowIndex: bestRow.i };
}

// === 閾値の考え方 ===
// 「取る」vs「引く」の判断は、今取った場合の得点と
// 待ち続けた場合の期待値の比較。
//
// 3枚列：これ以上カードは来ない。プラスなら即取る。
// 2枚列：もう1枚来る可能性がある。ただし：
//   - 次のカードが有益な確率は実はそれほど高くない
//     （7色×9枚中、自分に有益なのは限られる）
//   - 横取りリスクは「残り手番で他プレイヤーが取る確率」
//     ≒ 1 - (1 - 1/activeCount)^remainingTurns で近似
//   - でも基本的に序盤〜中盤は「引く」方が期待値が高い
// 1枚列：3枚まで待てる余地が大きい。高得点でないと取らない。

// 残り手番でこの列が横取りされる大まかなリスク
const activePlayers = g.players.filter((_, i) => !g.playersDone[i]).length;
// 次の自分の手番までに他プレイヤーが取る可能性（1手番分）
const stealProb = Math.min(0.4, (activePlayers - 1) * 0.12);

// 横取りされた場合の損失 = bestRow.gain（その得点を失う）
const stealLoss = bestRow.gain * stealProb;

// 待った場合の期待追加得点（1枚追加の期待値）
// 全63枚中、自分のトップ色に該当するカード数で推定
const sortedCounts = […counts].sort((a, b) => b - a);
const top3Sum = sortedCounts.slice(0, 3).reduce((s, v) => s + v, 0);
// デッキに残っている自分に有益な色の割合（粗い推定）
const usefulRatio = Math.max(0.15, Math.min(0.5, (27 - top3Sum * 2) / 63));
// 有益なカードが来たときの期待追加得点（1〜3点程度）
const expectedAddGain = usefulRatio * 2.5;

// 待つことの期待値 = 有益カード期待値 - 横取りリスク
const waitValue = expectedAddGain - stealLoss;

// 終盤補正：デッキが少ないほど待つ価値が下がる
const lateBonus = deckRatio < 0.3 ? 2 : deckRatio < 0.5 ? 0.8 : 0;

let takeThreshold;
if (bestRow.len >= 3) {
takeThreshold = 1;
} else if (bestRow.len === 2) {
// 取る価値が「待つ価値 + 固定コスト」を超えたら取る
// 固定コストは低めに設定（積極的に引かせる）
takeThreshold = waitValue + 1.5 - lateBonus;
} else {
// 1枚：かなり有利な状況でないと取らない
takeThreshold = waitValue + 4.5 - lateBonus;
}

if (bestRow.gain >= takeThreshold) {
return { action: "take", rowIndex: bestRow.i };
}
return { action: "draw" };
}

// Choose which row to place the pending card
function cpuChoosePlaceRow(g, playerIndex) {
const player = g.players[playerIndex];
const counts = countColors(player.hand);
const card = g.pendingCard;

const available = g.rows
.map((row, i) => ({ row, i }))
.filter(({ i }) => !g.rowTaken[i] && g.rows[i].length < (g.rowMaxCards?.[i] ?? 3));

if (available.length === 0) return null;

// Score each row for placing the pending card
function scoreRowForPlacement(row, ri) {
let s = 0;
// Prefer rows that match colors other players want (block them)
// Prefer rows that are already partially full (complete them)
s += row.length * 1.5; // prefer adding to existing rows

// If card benefits a player with lots of that color, place it in a bad row
// (simple: prefer placing in rows that already have diverse colors)
const rowColors = new Set(row.filter(c => c.type === "color").map(c => c.color));
if (card.type === "color" && rowColors.has(card.color)) s -= 2; // same color already there

return s;

}

return available
.map(({ i, row }) => ({ i, s: scoreRowForPlacement(row, i) }))
.sort((a, b) => a.s - b.s)[0].i; // place in LEAST valuable row for opponents
}

// ==================== GAME SETUP ====================
// Player count → { numColors, rowCount, rowMaxCards }
function getGameConfig(n) {
if (n === 2) return { numColors: 5, rowCount: 3, rowMaxCards: [1, 2, 3] };
if (n === 3) return { numColors: 6, rowCount: 3, rowMaxCards: [3, 3, 3] };
if (n === 4) return { numColors: 7, rowCount: 4, rowMaxCards: [3, 3, 3, 3] };
return           { numColors: 7, rowCount: 5, rowMaxCards: [3, 3, 3, 3, 3] };
}

function setupGame(players) {
const n = players.length;
const { numColors, rowCount, rowMaxCards } = getGameConfig(n);
let deck = buildDeck(numColors);

const usedColors = new Set();
const startingHands = players.map(() => {
const idx = deck.findIndex(card => card.type === "color" && !usedColors.has(card.color));
const card = deck[idx];
usedColors.add(card.color);
deck = deck.filter((_, i) => i !== idx);
return [card];
});

return {
players: players.map((p, i) => ({ …p, hand: startingHands[i], bonus: 0 })),
deck,
numColors,
rowMaxCards,
rows: Array(rowCount).fill(null).map(() => []),
rowTaken: Array(rowCount).fill(false),
playersDone: Array(n).fill(false),
currentPlayer: 0,
phase: "playing",
pendingCard: null,
message: "",
log: [],
};
}

// ==================== PURE STATE TRANSITIONS ====================
function applyDrawCard(g) {
if (g.deck.length === 0 || g.phase !== "playing" || g.pendingCard) return g;
let deck = […g.deck];
const card = deck.shift();
if (card.type === "end") {
// Skip end card, mark lastRound, then draw the next real card
if (deck.length === 0) return { …g, deck, lastRound: true, message: "🔔 ラストラウンド！（デッキ切れ）" };
const next = deck.shift();
return { …g, deck, lastRound: true, pendingCard: next, message: "🔔 ラストラウンド！終了カードが引かれました。どの列にカードを置きますか？" };
}
return { …g, deck, pendingCard: card, message: "どの列にカードを置きますか？" };
}

function applyPlaceCard(g, rowIndex) {
if (!g.pendingCard || g.phase !== "playing") return g;
const maxCards = (g.rowMaxCards || [])[rowIndex] ?? 3;
if (g.rowTaken[rowIndex] || g.rows[rowIndex].length >= maxCards) return g;

const rows = g.rows.map((r, i) => i === rowIndex ? […r, g.pendingCard] : […r]);
const log = [`${g.players[g.currentPlayer].name} が列${rowIndex + 1}にカードを置いた`, …g.log.slice(0, 9)];

const playersDone = g.playersDone;
let nextPlayer = (g.currentPlayer + 1) % g.players.length;
let safety = 0;
while (playersDone[nextPlayer] && safety < g.players.length) {
nextPlayer = (nextPlayer + 1) % g.players.length;
safety++;
}

const allRowsUnavailable = rows.every((r, i) => g.rowTaken[i] || r.length >= (g.rowMaxCards?.[i] ?? 3));
const message = allRowsUnavailable ? "全列が満杯です。列を取ってください。" : "";
let phase = g.phase;

return { …g, rows, pendingCard: null, currentPlayer: nextPlayer, log, message, phase };
}

function applyTakeRow(g, rowIndex) {
if (g.phase !== "playing") return g;
if (g.rowTaken[rowIndex] || g.rows[rowIndex].length === 0) return g;
const rowMax = (g.rowMaxCards || [])[rowIndex] ?? 3;

const rowTaken = […g.rowTaken];
rowTaken[rowIndex] = true;
const takenCards = […g.rows[rowIndex]];
const rows = g.rows.map((r, i) => i === rowIndex ? [] : […r]);

const playersDone = […g.playersDone];
playersDone[g.currentPlayer] = true;

const players = g.players.map((p, i) => {
if (i !== g.currentPlayer) return p;
let bonus = p.bonus;
const hand = […p.hand];
takenCards.forEach(c => { if (c.type === "plus2") bonus += 2; else hand.push(c); });
return { …p, hand, bonus };
});

const log = [`${g.players[g.currentPlayer].name} が列${rowIndex + 1}を取得（ラウンド終了）`, …g.log.slice(0, 9)];

const allDone = playersDone.every(Boolean);
let roundsLeft = g.roundsLeft ?? 3;
let phase = g.phase;
let message = "";

if (allDone) {
if (g.lastRound || g.deck.length === 0) {
return { …g, players, rows, rowTaken, playersDone, phase: "ended", log, message: "ゲーム終了！" };
}
const newRows = g.rows