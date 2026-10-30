---
name: polymarket
description: >
  Use when discovering Polymarket markets, comparing CLOB liquidity, reading an
  order book or quote, planning an order, or running auto mode. Auto mode does
  not place a live order unless POLYMARKET_AUTO_TRADE or agent.polymarketAutoTrade
  is enabled.
---

# Polymarket

`alice polymarket` reads the public Gamma and CLOB APIs. It is separate from
`alice market` bars and from `alice-uta` broker accounts. Auto Prediction still
owns its own research desk; these commands are the venue read and order plan.

## Find a market

```bash
alice polymarket search --q "fed rate"
alice polymarket select --q "fed rate" --max-spread 0.05 --min-depth-usd 100
```

`search` returns outcome names and the asset id. v1 markets use the CLOB token
id. v2 markets use the position id. Copy that id; do not invent one.

`select` reads each candidate book and keeps markets that are open, two-sided,
inside the spread cap, and deep enough near the touch. Rejected rows include
the reason. A listed market with a wide book is not a tradeable quote.

## Read the book

```bash
alice polymarket book --asset-id <assetId>
alice polymarket quote --asset-id <assetId>
```

Bids and asks are best-first. Quote reports the touch, mid, spread, and USDC
depth near the touch. Treat the result as a point-in-time public book, not a
fill guarantee.

## Plan an order

```bash
alice polymarket plan --asset-id <assetId> --side BUY --size 10 --order-type GTC --price 0.42
```

Size is shares. GTC and GTD need `--price`. FOK and FAK can omit it and walk
the book; FOK fails when depth is short, FAK shrinks to the resting size.
`--post-only` rejects a price that would cross.

The plan's `makerAmount` and `takerAmount` are 6-decimal base units. `submit`
defaults off. With auto trading off, `--submit` still does not POST.

## Auto mode

```bash
alice polymarket auto --q "fed rate" --side BUY --size 10 --price 0.42
```

Auto mode selects the best liquid outcome, plans the order, and submits it in
one step. It does not ask for Trading-as-Git approval. It posts only when
`POLYMARKET_AUTO_TRADE=1` or `agent.polymarketAutoTrade` is true, and only when
`POLYMARKET_PRIVATE_KEY`, `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, and
`POLYMARKET_API_PASSPHRASE` are already set. A proxy wallet also needs
`POLYMARKET_FUNDER` and `POLYMARKET_SIGNATURE_TYPE` (`1`, `2`, or `3`). Missing
material fails closed and the plan is returned unsent. Do not invent keys.
