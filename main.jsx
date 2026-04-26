import React, { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";

// ==================== CONSTANTS ====================
const COLORS = ["🔴", "🟡", "🟢", "🔵", "🟠", "🟣", "⚫"];
const COLOR_BG = ["#e74c3c","#f1c40f","#2ecc71","#3498db","#e67e22","#9b59b6","#34495e"];
const COLOR_LIGHT = ["#fadbd8","#fef9e7","#d5f5e3","#d6eaf8","#fdebd0","#e8daef","#d5d8dc"];
const SCORING = [0, 1, 3, 6, 10, 15, 21, 21]; // 6枚以上は21点

function buildDeck(numColors) {
  const deck = [];
  for (let col = 0; col < numColors; col++) {
    for (let i = 0; i < 9; i++) deck.push({ type: "color", color: col });
  }
  for (let i = 0; i < 3; i++) deck.push({ type: "joker" });
  for (let i = 0; i < 3; i++) deck.push({ type: "plus2" });
  
  // シャッフル (全角マイナスを修正)
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  
  const endPos = Math.max(0, deck.length - 15);
  deck.splice(endPos, 0, { type: "end" });
  return deck;
}

function getScore(counts, jokers = 0) {
  const c = [...counts]; // 三点リーダーをスプレッド構文に修正
  for (let j = 0; j < jokers; j++) {
    const sorted = c.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
    let bestGain = -Infinity, bestIdx = sorted[0].i;
    sorted.slice(0, 3).forEach(({ v, i }) => {
      const gain = SCORING[Math.min(v + 1, 6)] - SCORING[Math.min(v, 6)];
      if (gain > bestGain) { bestGain = gain; bestIdx = i; }
    });
    c[bestIdx]++;
  }
  const sorted = [...c].sort((a, b) => b - a);
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
function cpuDecide(g, playerIndex) {
  const player = g.players[playerIndex];
  const counts = countColors(player.hand);
  const deckRatio = g.lastRound ? 0 : g.deck.length / 67;
  const myJokers = countJokers(player.hand);

  function scoreGainForRow(row) {
    const newCounts = [...counts];
    let bonus = 0;
    let newJokers = myJokers;
    for (const card of row) {
      if (card.type === "plus2") { bonus += 2; continue; }
      if (card.type === "joker") { newJokers++; continue; }
      if (card.type === "color") newCounts[card.color]++;
    }
    const before = getScore(counts, myJokers);
    const after = getScore(newCounts, newJokers) + bonus;
    const totalColorsAfter = newCounts.filter(v => v > 0).length;
    const extraColorPenalty = Math.max(0, totalColorsAfter - 3) * 2;
    return (after - before) - extraColorPenalty;
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
  
  if (allRowsFull || g.lastRound) return { action: "take", rowIndex: bestRow.i };

  const activePlayers = g.players.filter((_, i) => !g.playersDone[i]).length;
  const stealProb = Math.min(0.4, (activePlayers - 1) * 0.12);
  const stealLoss = bestRow.gain * stealProb;
  const sortedCounts = [...counts].sort((a, b) => b - a);
  const top3Sum = sortedCounts.slice(0, 3).reduce((s, v) => s + v, 0);
  const usefulRatio = Math.max(0.15, Math.min(0.5, (27 - top3Sum * 2) / 63));
  const expectedAddGain = usefulRatio * 2.5;
  const waitValue = expectedAddGain - stealLoss;
  const lateBonus = deckRatio < 0.3 ? 2 : deckRatio < 0.5 ? 0.8 : 0;

  let takeThreshold;
  if (bestRow.len >= 3) {
    takeThreshold = 1;
  } else if (bestRow.len === 2) {
    takeThreshold = waitValue + 1.5 - lateBonus;
  } else {
    takeThreshold = waitValue + 4.5 - lateBonus;
  }

  if (bestRow.gain >= takeThreshold) return { action: "take", rowIndex: bestRow.i };
  return { action: "draw" };
}

function cpuChoosePlaceRow(g, playerIndex) {
  const available = g.rows
    .map((row, i) => ({ row, i }))
    .filter(({ i }) => !g.rowTaken[i] && g.rows[i].length < (g.rowMaxCards?.[i] ?? 3));
  if (available.length === 0) return null;
  return available
    .map(({ i, row }) => ({ i, s: row.length * 1.5 }))
    .sort((a, b) => a.s - b.s)[0].i;
}

// ==================== GAME SETUP ====================
function getGameConfig(n) {
  if (n === 2) return { numColors: 5, rowCount: 3, rowMaxCards: [1, 2, 3] };
  if (n === 3) return { numColors: 6, rowCount: 3, rowMaxCards: [3, 3, 3] };
  return { numColors: 7, rowCount: n, rowMaxCards: Array(n).fill(3) };
}

function setupGame(playerNames) {
  const n = playerNames.length;
  const config = getGameConfig(n);
  let deck = buildDeck(config.numColors);
  const startingHands = playerNames.map((_, i) => {
    const card = deck.find(c => c.type === "color" && c.color === i);
    deck = deck.filter(c => c !== card);
    return [card];
  });

  return {
    players: playerNames.map((name, i) => ({ name, hand: startingHands[i], bonus: 0 })),
    deck,
    rowMaxCards: config.rowMaxCards,
    rows: Array(config.rowCount).fill(null).map(() => []),
    rowTaken: Array(config.rowCount).fill(false),
    playersDone: Array(n).fill(false),
    currentPlayer: 0,
    phase: "playing",
    pendingCard: null,
    log: ["ゲーム開始！"],
  };
}

// ==================== MAIN COMPONENT ====================
export default function Coloretto() {
  const [game, setGame] = useState(null);

  useEffect(() => {
    setGame(setupGame(["あなた", "CPU 1", "CPU 2"]));
  }, []);

  const handleAction = (action, payload) => {
    if (!game || game.phase === "ended") return;
    let nextG = { ...game };

    if (action === "draw") {
      const card = nextG.deck.shift();
      if (card.type === "end") {
        nextG.lastRound = true;
        nextG.pendingCard = nextG.deck.shift();
      } else {
        nextG.pendingCard = card;
      }
    } else if (action === "place") {
      nextG.rows[payload].push(nextG.pendingCard);
      nextG.pendingCard = null;
      nextG.currentPlayer = (nextG.currentPlayer + 1) % nextG.players.length;
      while (nextG.playersDone[nextG.currentPlayer]) {
        nextG.currentPlayer = (nextG.currentPlayer + 1) % nextG.players.length;
      }
    } else if (action === "take") {
      const player = nextG.players[nextG.currentPlayer];
      nextG.rows[payload].forEach(c => {
        if (c.type === "plus2") player.bonus += 2;
        else player.hand.push(c);
      });
      nextG.rows[payload] = [];
      nextG.rowTaken[payload] = true;
      nextG.playersDone[nextG.currentPlayer] = true;
      
      if (nextG.playersDone.every(d => d)) {
        if (nextG.lastRound) {
          nextG.phase = "ended";
        } else {
          nextG.rowTaken = nextG.rowTaken.map(() => false);
          nextG.playersDone = nextG.playersDone.map(() => false);
          nextG.currentPlayer = 0; // 次のラウンド
        }
      } else {
        nextG.currentPlayer = (nextG.currentPlayer + 1) % nextG.players.length;
        while (nextG.playersDone[nextG.currentPlayer]) {
          nextG.currentPlayer = (nextG.currentPlayer + 1) % nextG.players.length;
        }
      }
    }
    setGame(nextG);
  };

  if (!game) return <div>Loading...</div>;

  return (
    <div style={{ padding: "10px", fontFamily: "sans-serif", maxWidth: "500px", margin: "auto" }}>
      <h1>Coloretto</h1>
      <div style={{ background: "#eee", padding: "10px", marginBottom: "10px" }}>
        {game.phase === "ended" ? "🎉 ゲーム終了！" : `手番: ${game.players[game.currentPlayer].name}`}
      </div>

      <div style={{ display: "flex", gap: "10px", marginBottom: "20px" }}>
        {game.rows.map((row, i) => (
          <div key={i} style={{ border: "1px solid #ccc", minHeight: "100px", flex: 1, padding: "5px", opacity: game.rowTaken[i] ? 0.3 : 1 }}>
            <div>列 {i + 1}</div>
            {row.map((c, j) => <span key={j}>{c.type === "color" ? COLORS[c.color] : c.type === "joker" ? "🃏" : "➕"}</span>)}
            {game.currentPlayer === 0 && game.pendingCard && !game.rowTaken[i] && row.length < game.rowMaxCards[i] && (
              <button onClick={() => handleAction("place", i)} style={{ width: "100%", marginTop: "5px" }}>置く</button>
            )}
            {game.currentPlayer === 0 && !game.pendingCard && !game.rowTaken[i] && row.length > 0 && (
              <button onClick={() => handleAction("take", i)} style={{ width: "100%", marginTop: "5px" }}>取る</button>
            )}
          </div>
        ))}
      </div>

      {game.currentPlayer === 0 && !game.pendingCard && game.phase !== "ended" && (
        <button onClick={() => handleAction("draw")} style={{ padding: "10px 20px", fontSize: "1.2rem", width: "100%" }}>カードを引く</button>
      )}

      {game.pendingCard && <div style={{ textAlign: "center", margin: "10px" }}>引いたカード: {game.pendingCard.type === "color" ? COLORS[game.pendingCard.color] : "🃏"}</div>}

      <div style={{ marginTop: "20px" }}>
        <h3>あなたの手札</h3>
        {game.players[0].hand.map((c, i) => <span key={i}>{c.type === "color" ? COLORS[c.color] : "🃏"}</span>)}
        <div>スコア: {getScore(countColors(game.players[0].hand), countJokers(game.players[0].hand)) + game.players[0].bonus} 点</div>
      </div>
    </div>
  );
}

const container = document.getElementById("root");
const root = createRoot(container);
root.render(<Coloretto />);
