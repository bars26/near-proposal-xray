# Proposal X-Ray

Read any Sputnik DAO or Trezu proposal before you vote: what it really sends, to whom, through which contract, and what it changes about who controls the treasury.

Built at **NEAR HACKATHON** (Nov 2026) for the **Social Money** track (also fits AI Security & Defense).

- Live site: https://near-proposal-xray.vercel.app
- Feed data: a snapshot ships with the site (`public/feed.json`); the [`feed` workflow](.github/workflows/feed.yml) rebuilds it hourly on the [`data` branch](https://github.com/bars26/near-proposal-xray/tree/data), which the site prefers when present

## The problem

Sputnik DAO v2 is the multisig behind most NEAR treasuries, including every [Trezu](https://trezu.org) treasury (they are created by the same `sputnik-dao.near` factory). Members approve proposals that are often `FunctionCall`s with base64-encoded arguments. In practice voters read the title the proposer wrote, not the payload:

- A `FunctionCall` can hold **several actions**. Summary views (Trezu's payment extractor included, see `nt-fe/features/proposals/utils/proposal-extractors.ts`, which uses `actions.find(...)`) show the first matching action.
- Treasury apps sort proposals by a **`Proposal Action` label in the description**, and the proposer writes that label.
- The **amount in the text** and the amount in the arguments are two separate fields.
- Policy changes (`AddMemberToRole`, `ChangePolicyAddOrUpdateRole`, ...) can quietly turn a 2-of-3 into a **1-of-1**, and nothing shows the before/after.
- `UpgradeSelf` takes a code hash. Nothing tells voters whether that hash is an official Sputnik release.

## What it does

For one proposal, a DAO, or every recent proposal on NEAR:

1. **Decodes every action**: `ft_transfer(_call)`, NEAR Intents `ft_withdraw` / `mt_withdraw` (including `WITHDRAW_TO:` cross-chain destinations), `mt_transfer`, NFT transfers, staking-pool deposits/unstakes, wNEAR wraps, lockup transfers, ownership/admin/upgrade calls, raw deposits.
2. **Recomputes the vote math** exactly as the contract does (`sputnikdao2/src/policy.rs`: `to_weight`, `proposal_status`, `can_execute_action`): which roles can pass it, how many approvals are left, when it expires.
3. **Diffs policy changes** against today's policy: approvals needed to send funds / call contracts / rewrite rules / add members / replace code, before vs after.
4. **Checks the payload against the chain**: DAO balances (NEAR, NEP-141 and NEAR Intents `mt_balance_of`), recipient existence, contract code presence, token metadata, and the factory's published code hashes (`get_contracts_metadata`).
5. **Raises findings** (critical / high / check / note):

| id | severity | fires when |
| --- | --- | --- |
| `upgrade-unknown` | critical | `UpgradeSelf` hash is not a release published by `sputnik-dao.near` |
| `upgrade-unverified` | critical | `UpgradeSelf` while the factory's release list could not be loaded: never reported as "official" |
| `single-signer` | critical | after an open policy change, one account can approve a sensitive kind alone |
| `treasury-share` | critical ≥50% / high ≥20% | an open proposal moves that share of the DAO's balance of an asset |
| `control-change` | critical / high | calls `set_owner`, `add_admin`, `upgrade`, `migrate`, `grant_role`, `pause`, ... on another contract |
| `hidden-action` | high | a multi-action call where action #2+ also moves funds or control |
| `label-mismatch` | high | Trezu `Proposal Action` label does not match the payload |
| `description-mismatch` | high | amounts written in the text (e.g. "500 USDT", "$750") match no amount actually sent |
| `recipient-missing` | high (NEAR) / check | named recipient account does not exist (typo) |
| `fewer-signers`, `short-period`, `staking-contract`, `upgrade-remote`, `self-call` | high | as named |
| `self-dealing` | check | proposer can vote on it and is paid by it |
| `ambiguous-amount` | check | the text names several amounts in the payment's unit and only some match (e.g. "pay 500 USDT, budget 5,000 USDT" while 5,000 is sent) |
| `opaque-args`, `call-no-code`, `call-missing`, `exceeds-balance`, `batch` | check | as named |
| `outsider`, `cross-chain`, `one-vote-away`, `member-added/removed` | note | context |

Rules only fire on facts that were actually fetched; a failed RPC lookup never becomes a warning. Balance and policy rules only run on proposals that are still open (finished proposals are already reflected in today's balances and policy).

**"No warning" is not the same as "safe".** Every report also lists the checks that could not run: a method X-Ray does not model (e.g. `donate` on a Potlock pot), a recipient or contract whose existence could not be confirmed, an unknown DAO balance, missing token metadata, an unavailable release list. A proposal with no findings but a non-empty list is shown as **Partly checked** (dashed badge) with a "Not checked" section, never as **Clean**.

## Found on mainnet

From a scan of 3,133 proposals in 450 active DAOs (last 90 days):

- **`deer.sputnik-dao.near` #0–#4**: five proposals titled "Upgrade Sputnik-DAO Contract to 3.2" pass the code hash `…U9hJXu`, one character short of the official v3.2 hash `…U9hJXuF`. X-Ray: *"Code hash only looks like Sputnik v3.2"*. Open `#/dao/deer.sputnik-dao.near/3`.
- **`dti-lab-jj.sputnik-dao.near` #56**: titled "Transferencia de 200 NEAR", the payload sends **275 NEAR** to the proposer. X-Ray: *"Description and payload disagree"* plus *"An approver pays themself"*. (The DAO rejected it.)

## Try it (judges: "do X → see Y")

**In the browser**, open the live site, then:

1. Click **"Payment with a hidden second action"** → verdict **Critical**; findings include *"2 calls in one proposal; action #2 also moves funds or control"* and *"Moves 81% of the DAO's USDt"*. "What it does" lists both transfers.
2. Click **"Labelled payroll, hands over a contract"** → **Critical**: *"Changes control of token.demo.near"* and *"Labelled "payment-transfer" but does something else"*.
3. Click **"Upgrade to unknown code"** → **Critical**: *"Replaces the DAO's code with unknown code"*.
4. Click **"New role that can spend alone"** → **Critical**: *"One account could approve alone"*.
5. Click **"Normal payment"** → no warnings, only a note that the proposer is not a member.
6. Type `marketing` in the search box → the real `marketing.sputnik-dao.near` page: 3 members, contract v3.0, 2 approvals needed for everything, last 40 proposals with verdicts.
7. Open `#/dao/marketing.sputnik-dao.near/1026` → a real `FunctionCall` decoded: *"Sends 1 NEAR to marketing.v1.potfactory.potlock.near — deposit attached to donate"* with the JSON arguments. The badge is **Partly checked**, and "Not checked" says X-Ray does not model `donate` on that contract.
8. The home page **Live feed** lists recent proposals across all Sputnik DAOs, filterable by *High risk* / *Open now* / *All*.

The 8 samples run against a demo treasury in the page (no chain writes). `test/samples.test.ts` asserts every outcome above.

**Locally** (Node 24):

```sh
npm ci
npm test                      # 42 tests: vote math, decoding, every rule, every sample, "partly checked" cases
npm run dev                   # http://localhost:5173
npm run inspect -- marketing --last 5       # X-ray a DAO's last 5 proposals in the terminal
npm run inspect -- marketing 1026 --json    # one proposal as JSON
npm run feed -- --days 30 --calibrate       # scan every DAO, print how often each rule fires
```

No keys, no wallet, no environment variables. Everything is read-only NEAR mainnet RPC.

## How NEAR is used

- **Sputnik DAO v2 view methods** on every DAO: `get_policy`, `get_proposals`, `get_proposal`, `get_last_proposal_id`.
- **The factory** `sputnik-dao.near`: `get_dao_list` (all DAOs, Trezu's included) and `get_contracts_metadata` (official code hashes → versions).
- **NEAR Intents** `intents.near`: decodes `ft_withdraw` / `mt_withdraw` / `mt_transfer`, follows `WITHDRAW_TO:` memos to the external chain address, reads the DAO's Intents balance with `mt_balance_of`.
- **NEP-141 / NEP-171 / NEP-245**: `ft_metadata`, `ft_balance_of`, transfers of fungible, non-fungible and multi tokens.
- **`view_account`** for balances, account existence and deployed code hash.
- RPC: `near.drpc.org`, `rpc.mainnet.fastnear.com`, `rpc.intea.rs` (+ `archival-rpc.mainnet.near.org` server-side), rotated with backoff because public RPCs rate-limit (FastNEAR signals it with HTTP 200 + `code: -429`).

## Layout

```
src/policy.ts    vote math + policy diff, mirrored from sputnikdao2
src/decode.ts    args decoding, effects (outflows, staking, control), description parsing
src/analyze.ts   the rules → Report
src/chain.ts     RPC loaders + on-chain facts
src/dao.ts       DAO-level health (approvals needed, contract version)
src/samples.ts   crafted proposals for the demo
src/main.ts      the site (vanilla TS + Vite)
scripts/         inspect.ts (CLI), build-feed.ts (hourly feed)
test/            vitest
```

## Hackathon disclosure

- All code in this repository was written during NEAR HACKATHON (first commit 2026-11-09). No pre-hackathon code.
- Libraries: none at runtime. Dev: Vite, TypeScript, Vitest. Fonts: IBM Plex via Google Fonts.
- Written with Claude Code (AI-assisted).
- License: MIT.
