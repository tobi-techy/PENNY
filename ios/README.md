# Penny iOS

Two targets, one shared package:

| Target | What it is |
|---|---|
| **PennyHost** | The iPhone app. Links this iPhone to Penny (enter the 8-character code Penny texts you), shows your wallet, key, limits, and a card gallery. |
| **PennyMessages** | The iMessage extension. Renders Penny's live cards in the thread and runs Approve → Face ID → sign → submit → live status. |
| **PennyKit** (Swift package) | `PennyCore`: Base58, Borsh, NEP-366 delegate actions, RFC 8785 canonical JSON, engine API client, Keychain key store. `PennyUI`: the card, dither art, crew marks, Geist fonts. |

```
ios/
  project.yml                XcodeGen spec (generates Penny.xcodeproj)
  Config/Base.xcconfig       team id, bundle prefix, engine host (override in Config/Local.xcconfig)
  PennyHost/                 app: PennyHostApp, EnrollView, HomeView, Assets
  PennyMessages/             extension: MessagesViewController, Assets (iMessage App Icon)
  PennyKit/
    Sources/PennyCore/       Encoding, Borsh, DelegateAction, JSON, CanonicalJSON, Approval, EngineClient, Signing, DeviceKeyStore, SharedConfig
    Sources/PennyUI/         Theme, CrewMark, DitherArt, CardModel, PennyCardView, ApprovalCardModel, ApprovalCardScreen, Resources/Fonts (Geist OTF, OFL)
    Tests/PennyCoreTests/    XCTest + Fixtures/delegate-vectors.json
```

## 1. One-time setup on your Mac

```bash
brew install xcodegen
cd penny/ios
cp Config/Local.xcconfig.example Config/Local.xcconfig
```

Edit `Config/Local.xcconfig`:

```
PENNY_TEAM_ID = ABCDE12345            # developer.apple.com > Account > Membership > Team ID
PENNY_BUNDLE_PREFIX = app.penny       # change if app.penny.host is taken, e.g. com.tobibuilder.penny
PENNY_ENGINE_HOST = your-engine.fly.dev   # host only, no https:// (xcconfig treats // as a comment)
```

Then:

```bash
xcodegen generate
open Penny.xcodeproj
```

Re-run `xcodegen generate` any time you add files or change `project.yml`.

## 2. Run on your iPhone

1. Plug in the iPhone, enable **Developer Mode** (Settings > Privacy & Security), make sure **Face ID and a passcode are on** (the key can't be created without them).
2. In Xcode pick the **PennyHost** scheme and your iPhone, press Run. Automatic signing creates the App IDs, the App Group `group.<prefix>.host` and the shared Keychain group for both targets. If Xcode complains about the App Group, open each target's *Signing & Capabilities*, and click the red App Group once to register it.
3. Text Penny, get your 8-character code, type it in the app → **Link this iPhone**.
4. In Messages, the Penny extension appears in the app drawer. Cards Penny sends render in the thread.
5. To debug the extension: pick the **PennyMessages** scheme → Run → choose **Messages** when asked.

Unit tests (Borsh, NEP-366 vectors, JCS vectors shared with the TypeScript packages):

```bash
cd PennyKit && swift test        # or Product > Test on the PennyHost scheme
```

## 3. Point it at the engine

- Release builds use `https://$(PENNY_ENGINE_HOST)` baked into both Info.plists (`PennyEngineURL`).
- Debug builds: Penny app > **Server** lets you paste any https URL (saved in the shared App Group so the extension uses it too). **Check** calls `/healthz`.
- The engine must send cards with the same identity: `extensionBundleId = <prefix>.host.messages`, `teamId = PENNY_TEAM_ID` (SpectrumConfig in apps/engine).

## 4. TestFlight

1. App Store Connect > My Apps > **+** > New App, bundle id `<prefix>.host`. (The extension rides inside the app.)
2. Xcode: scheme **PennyHost**, destination *Any iOS Device (arm64)*, **Product > Archive**.
3. Organizer > **Distribute App** > App Store Connect > Upload. Bump `CURRENT_PROJECT_VERSION` in `project.yml` for every upload.
4. In App Store Connect > TestFlight, add yourself as an internal tester. Export compliance is pre-answered (`ITSAppUsesNonExemptEncryption = NO`, standard crypto only). Re-check that answer before external testing.

## How approval works on the phone

1. The live card's URL carries the approval id and a short-lived card token: `https://<engine>/a/<approvalId>#t=<cardToken>` (query form `?approvalId=…&cardToken=…` also accepted). The URL's host is ignored; requests go to the configured engine.
2. `GET /v1/approvals/:id` with `Authorization: Card <token>`. Parsed strictly: unknown keys rejected, ids/u64/u128 format-checked, only `FunctionCall` and `Transfer` actions allowed.
3. Tap Approve → device builds the NEP-366 `DelegateAction` from the approval fields → `sha256(borsh(u32 1073742190) ‖ borsh(DelegateAction))` → Face ID → ed25519 sign → self-verify → `POST /submit` with base64 borsh `SignedDelegateAction`.
4. Poll `/status` (1.2 s, backing off to 3 s) and tick steps until settled.

Prefix source: NEP-461 discriminant `2^30 + 366`, from nearcore `core/primitives/src/signable_message.rs` (`MIN_ON_CHAIN_DISCRIMINANT = 1 << 30`, `NEP_366_META_TRANSACTIONS = 366`). Field order from NEP-366. The fixture `delegate-vectors.json` was generated with `@near-js/transactions` and the Swift output matches byte for byte.

## Contract notes for the engine

- **FunctionCall args bytes** = UTF-8 of RFC 8785 canonical JSON of the `args` object (same as `canonicalBytes(want.args)` in packages/chain). Anything else fails the byte check.
- Card token is sent on **all** approval routes (GET, submit, decline, status).
- POSTs carry `Idempotency-Key` (`submit-<approvalId>`, `decline-<approvalId>`, random UUID for enroll).
- Enroll sends `publicKeyEd25519` as unpadded base64url of the 32 raw bytes.

## Security notes

- The private key is a 32-byte ed25519 seed in the Keychain with `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly` + `.biometryCurrentSet`. It is never synced, never backed up, and becomes unreadable if Face ID enrolment changes. No API returns it. The Secure Enclave can't hold ed25519 keys, so this is Keychain-protected, not SE-backed.
- "Remove this iPhone" is a placeholder on purpose: deleting the only full-access key locally would lock the wallet. It must swap the key on-chain first.
- Nothing logs tokens, keys or bodies. The App Group holds only non-secret settings (engine URL, account id).
