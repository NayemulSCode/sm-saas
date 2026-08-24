# 22. Internationalization architecture

Languages at launch: **`en`** and **`bn`** (`bn-BD`). The locale code is **`bn`**,
never `ba`. Platform timezone is fixed to `Asia/Dhaka`.

Bangla here is not a translation layer over an English product. Roughly half the
data in the system is *authored* in Bangla, and correctness — normalisation,
collation, shaping — is a data concern before it is a UI concern.

## 22.1 The split that matters

Three kinds of text, three different mechanisms. Confusing them is the usual
failure.

| Kind | Where it lives | Translated by | Example |
|---|---|---|---|
| **UI strings** | Message files in the repo, `next-intl` | The team | "Save", "Outstanding dues" |
| **Tenant content** | Database columns, per language | The school | School name, notice body, custom role name |
| **Real bilingual data** | **Two columns**, both authoritative | Whoever enters it | `person.name_bn` / `person.name_en` |

The third is the one designs get wrong. A student's Bangla name and English name
are **not translations of each other** — the report card prints one, the board
registration list needs the other, and neither is derivable from the other.
Modelling them as a localised field with a fallback produces a report card that
silently prints English into a Bangla document.

```sql
-- Right: both real, both required where the domain needs them.
name_bn text NOT NULL,
name_en text NOT NULL

-- Wrong: implies one is a translation of the other.
name jsonb  -- { "bn": "...", "en": "..." }
```

Tenant content that genuinely *is* the same thing in two languages — a notice, a
holiday title, a fee head name — uses paired nullable columns (`title_bn`,
`title_en`) with a defined fallback. Adding a third language then adds columns
or a side table; either way it is a migration, not a redesign (FR-X.3).

## 22.2 UI strings

```
src/messages/
  en/  common.json  students.json  fees.json  assessment.json  …
  bn/  common.json  students.json  fees.json  assessment.json  …
```

Namespaced per module, matching [§9.1](../phase-1a/09-domain-boundaries.md), so a
module's strings live with the module rather than in one growing file. Loaded per
route segment — a guardian route does not download admin vocabulary, which is a
real share of the bundle budget.

| Rule | Reason |
|---|---|
| Keys are semantic (`fees.receipt.printed`), not English text | Renaming English copy does not churn every file |
| **No string concatenation.** ICU messages with placeholders only | Word order differs; Bangla is SOV |
| Every user-visible string goes through `t()` | Enforced by an ESLint rule flagging bare JSX text |
| Missing `bn` falls back to `en` **and is reported** | Silent fallback is how a half-translated release ships |

## 22.3 Pluralisation and formatting

Bangla plural rules differ from English and are handled by ICU, not by `if
(n === 1)`:

```json
{
  "students.count": "{count, plural, one {# জন শিক্ষার্থী} other {# জন শিক্ষার্থী}}",
  "dues.overdue": "{days, plural, one {# দিন বকেয়া} other {# দিন বকেয়া}}"
}
```

Bangla frequently uses the same form for one and many — which is exactly why it
must be expressed as a plural rule rather than assumed. A hand-rolled `+ 's'`
produces nonsense.

### Numerals

Bangla has its own digits (০১২৩৪৫৬৭৮৯). Whether to use them is **tenant
configuration**, per surface:

| Surface | Default | Configurable |
|---|---|---|
| UI | Latin digits | Yes |
| Report cards, marksheets | **Bangla digits** | Yes |
| Money receipts | Bangla digits, amount in words in Bangla | Yes |
| Data entry fields | **Always Latin**, always | No |
| Exports, CSV | Always Latin | No |

Data entry is Latin-only deliberately: a keypad on a low-end Android emits Latin
digits, and accepting both invites parsing ambiguity in a field that holds money.
Rendering is a display concern; input is a correctness concern.

Amount-in-words in Bangla ("পাঁচ হাজার তিনশত টাকা") is a required feature on
receipts and is a non-trivial function — the Indic numbering system uses lakh and
crore, so it is not a translation of an English words-generator.

### Dates

Gregorian calendar, `Asia/Dhaka`, formatted per locale. Bangla month names
rendered in Bangla. The Bengali calendar (Bangabda) is **not** implemented —
schools operate on the Gregorian calendar. Noted as a possible later addition for
document footers, not as a scheduling system.

## 22.4 Typography and fonts

| Role | Font | Note |
|---|---|---|
| Bangla body | **Noto Sans Bengali** | Broad coverage, actively maintained |
| Bangla display / documents | **Noto Serif Bengali** | Report cards and certificates |
| Latin body | Inter | Pairs acceptably at similar optical size |
| Latin display | Noto Serif | Matches the Bangla serif |

Consistent with the `bdagency` decision to reject Manrope for lack of Bengali
coverage.

| Concern | Approach |
|---|---|
| Payload | Subset to the actually-used range; target ≤ 120 KB total ([§4.4](../phase-1a/04-non-functional-requirements.md)) |
| Loading | `font-display: swap`, preload the Bangla body face |
| Fallback | System Bangla fonts declared in the stack — a fallback that cannot render Bangla shows boxes |
| **PDF** | Fonts **pinned and baked into the worker image**, never fetched at render time ([ADR-0009](../adr/0009-pdf-rendering.md)) |
| Line height | Bangla needs more leading than Latin — matras and reph sit above the line. Set per script, not globally |

## 22.5 Text handling in the data layer

| Concern | Rule |
|---|---|
| Encoding | UTF-8 everywhere |
| **Normalisation** | Unicode **NFC on write**, without exception |
| Collation | ICU `bn-BD` on name columns needing human alphabetical order |
| Search | `pg_trgm` GIN — works on Bangla with no language dictionary |
| Full text | `simple` configuration; there is no Bangla stemmer and pretending otherwise is worse than admitting it |

NFC normalisation is the one that bites. Bangla conjuncts have multiple valid
encodings, so ম + ্ + ব entered two ways produces two byte sequences that look
identical and do not compare equal. Without normalisation on write: duplicate
students that cannot be merged, searches that miss, and unique constraints that
do not constrain. It must be applied **before any index is built**.

## 22.6 Localisation of non-UI surfaces

Everything user-facing is localised, not just screens:

| Surface | Mechanism |
|---|---|
| Validation and error messages | Zod messages keyed to the same catalogue; API returns a localised `message` with a stable `code` ([§19.3](19-api-architecture.md)) |
| SMS templates | Per-locale rows, with segment counting per encoding ([§18.2](18-notification-architecture.md)) |
| Email | Per-locale templates |
| PDFs | Template + locale, with the tenant's numeral preference |
| CMS content | Per-locale pages and slugs ([§21](21-cms-architecture.md)) |
| Report column headers | Message catalogue |
| Exported CSV headers | **English only** — files are opened in Excel and re-imported; stable headers matter more than localisation |

## 22.7 Localisation QA

Runs in CI, because a half-translated release is otherwise invisible until a
user finds it.

| Check | Fails the build? |
|---|---|
| Key parity between `en` and `bn` | **Yes** — a missing key is a bug, not a to-do |
| Unused keys | No — reported |
| ICU syntax validity | Yes |
| Bare JSX text outside `t()` | Yes |
| Bangla characters in an `en` SMS template | Yes — it triples the cost ([§18.2](18-notification-architecture.md)) |
| Layout overflow at `bn` string lengths | Visual regression test on key screens |

**Bangla strings run roughly 20–40% longer than English** for the same meaning.
Layouts are therefore designed and reviewed in `bn` first: a layout that fits
Bangla fits English, and the reverse is false. Buttons, table headers and
navigation are where it breaks.

## 22.8 Adding a third language later

The path, so it is known to be cheap:

1. Add `src/messages/<locale>/`; CI parity check immediately shows what is missing.
2. Add the locale to routing and the tenant locale enum.
3. Add `title_<locale>` columns (or a side table) for tenant content — a
   migration, no redesign.
4. Add per-locale template rows for SMS, email and documents.
5. Add fonts if the script requires them.

Nothing in the schema assumes exactly two languages **except** the deliberate
`name_bn` / `name_en` pair, which is a domain fact about Bangladeshi records
rather than a localisation mechanism, and would not change.
