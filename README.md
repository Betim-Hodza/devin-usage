# devin-usage

Account plan, quota and credit usage for the [Devin](https://devin.ai) provider
in [pi](https://github.com/mariozechner/pi) — quota bars in a transcript card
plus a compact footer status.

```
/devin-usage     # full report card (plan, daily/weekly quota, credit buckets)
/devin-models    # per-model credit multipliers (burn rate vs 1×)
```

A summary also lands in the footer status on session start
(`devin: Pro · day 82% · wk 91%`).

## What you get

- **Plan** — Devin Pro / Teams / Free, org, billing window
- **Daily & weekly quota** — % remaining with reset countdowns
- **Credit buckets** — prompt / flow / flex credits used and left
- **Model burn rates** — every registered Devin model's `credit_multiplier`
  (×2 cheap, ×230 premium) sorted cheapest-first, with cost tier and pricing
  type, flagging your active model
- **Overage** — any overage balance surfaced when present

## How it works

Devin ships no REST usage endpoint; everything comes from one unary Connect
RPC the native CLI issues at startup, ported here from oh-my-pi:

```
POST https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus
Content-Type: application/proto
Connect-Protocol-Version: 1
Body: raw (unframed) GetUserStatusRequest protobuf
```

The backend gates the response on the `Metadata` identity tuple — the request
must announce itself as the released Devin CLI ("chisel"), not the Windsurf
identity `pi-devin-auth` uses for chat:

```
ide_name "devin-cli" · ide_type "chisel" · ide_version "3000.6.2"
extension_name "chisel" · extension_version "3000.6.2"
```

**Caveat:** this is an undocumented internal endpoint guarded by a client
identity check. It works today; Cognition could change or gate it at any
time, at which point the command will fail loudly until updated.

Requires the Devin provider to be signed in (`/login devin`) — the API key
comes from pi's own model registry, nothing is stored by this extension.

## Install

```bash
pi install git:github.com/betim-hodza/devin-usage
```

or try it once without installing:

```bash
pi -e git:github.com/betim-hodza/devin-usage
```

## License

MIT
