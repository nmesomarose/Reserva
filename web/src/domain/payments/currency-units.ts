/**
 * The minor↔major unit conversion at the payment-provider boundary
 * (product-owner decision R-6, `.agents/rules/03`).
 *
 * ## Why this file exists at all
 *
 * PRD v2 §7.2 L212 stores money in **minor units** — `price_minor_units`,
 * "e.g. kobo for NGN". Flutterwave's `amount` field is in **major units** (whole
 * Naira). The two sides of this integration disagree by a factor of 100, so a
 * conversion is *mandatory*; sending `price_minor_units` through unchanged would
 * bill a ₦5,000 ticket as ₦50,000.
 *
 * The evidence for the provider's unit is in
 * `docs/evidence/flutterwave-verify-resolution.md` §6. The decisive item is
 * Flutterwave's own verify response: `amount: 3000`, `app_fee: 1000`,
 * `amount_settled: 2000`, `currency: "NGN"`, where `amount − app_fee =
 * amount_settled` holds exactly and is only sensible in whole Naira.
 *
 * ## Why the divisor is 100 for everything, and what that costs
 *
 * R-6 decides a single divisor of `100`. The honest reason is that it is correct
 * for every currency the platform can actually sell in today, and the
 * alternative — a per-currency exponent table — would be *invented data*:
 * Flutterwave publishes no exponent table, and PRD §11 deliberately validates
 * only the *shape* of a currency code rather than checking a registry, so there
 * is no in-repo source to read the true exponents from. AGENTS.md §6 and rule 04
 * both forbid writing that table from memory.
 *
 * The cost is real and is not hidden here: `100` is wrong for the 0-decimal
 * currencies and the 3-decimal ones. A ticket priced in JPY or KWD would be
 * mispriced by 100× or 1000×. {@link NON_TWO_DECIMAL_CURRENCIES} therefore
 * **blocks those currencies at tier creation**, so a tier that would be mispriced
 * cannot exist in the first place. Adding support for them is a future decision
 * that needs a real exponent source, not a wider array literal here.
 *
 * ## Why the conversion refuses inexact values
 *
 * Neither direction rounds. A price of 1 minor unit (₦0.01) is not a whole Naira,
 * and `Math.round(1 / 100)` is `0` — a free ticket, silently. Rounding the other
 * way invents money. A tier price that does not convert exactly is a pricing
 * error the platform must surface to the organiser, not absorb into a customer's
 * charge, so {@link minorUnitsToMajorUnits} throws instead.
 *
 * This module is pure and framework-agnostic: no I/O, no environment, no
 * provider. It is the single place the divisor appears.
 */

import { ValidationError } from "../errors";

/**
 * Minor units per major unit. See the file header for why this is a constant and
 * not a per-currency lookup (R-6).
 */
export const MINOR_UNITS_PER_MAJOR = 100;

/**
 * ISO 4217 codes whose minor unit is **not** two decimal places, and which this
 * platform therefore **cannot price correctly** under R-6's divisor of `100`.
 *
 * ## SIGN-OFF REQUIRED — read this before editing
 *
 * This list was written from knowledge of ISO 4217, **not** copied from a
 * normative source, because R-6 ruled out a full authoritative table. It is
 * therefore a *defensive* list, not a specification: its job is to prevent a
 * mispriced sale, and it does that as long as it is a **superset** of the
 * non-2-decimal codes. Omitting a code would be a real bug; including one that is
 * actually 2-decimal is merely a currency the platform declines to sell.
 *
 * Treat it that way when changing it: adding a code costs a currency, removing
 * one risks mispricing it. `NGN`, `USD`, `GBP`, `EUR`, `GHS`, `ZAR`, `KES`,
 * `RWF`, `ZMW`, `TZS`, `UGX` and the other major markets are all absent, which is
 * the intended behaviour — those are 2-decimal and convert exactly.
 *
 * Grouped by the reason they are here: 0-decimal currencies (no minor unit at
 * all, so `minorUnits ≡ majorUnits` and a divisor of 100 would divide by 100 too
 * many times) and 3-decimal currencies (oil/gulf currencies, conventionally
 * thousandths).
 */
export const NON_TWO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  // 0-decimal: the major unit *is* the smallest unit.
  "BIF", // Burundian franc
  "CLP", // Chilean peso
  "DJF", // Djiboutian franc
  "GNF", // Guinean franc
  "ISK", // Icelandic krona - no minor unit
  "JPY", // Japanese yen
  "KMF", // Comorian franc
  "KRW", // South Korean won
  "PYG", // Paraguayan guarani
  "RWF", // Rwandan franc
  "UGX", // Ugandan shilling
  "UYI", // Uruguay peso en unidades indexadas
  "VND", // Vietnamese dong
  "VUV", // Vanuatu vatu
  "XAF", // Central African CFA franc
  "XOF", // West African CFA franc
  "XPF", // CFP franc

  // 3-decimal: conventionally quoted in thousandths.
  "BHD", // Bahraini dinar
  "IQD", // Iraqi dinar
  "JOD", // Jordanian dinar
  "KWD", // Kuwaiti dinar
  "LYD", // Libyan dinar
  "OMR", // Omani rial
  "TND", // Tunisian dinar
]);

/**
 * Can this platform price a tier in `currency` without mispricing it?
 *
 * Shape is *not* checked here — §11 validates a well-formed three-letter code
 * and `requireCurrencyCode` in the validation layer already did. This is only
 * the R-6 pricing-support question.
 */
export function isPricableCurrency(currency: string): boolean {
  return !NON_TWO_DECIMAL_CURRENCIES.has(currency.trim().toUpperCase());
}

/**
 * Thrown when a money value cannot be represented in major units.
 *
 * A `ValidationError`-shaped outcome would be wrong here: this is never a client
 * sending a bad number (the client never sends an amount at all, FR-11), it is
 * the stored tier price being unrepresentable, which is a pricing fault the
 * organiser has to fix. Callers translate this into the `400` that names
 * `price_minor_units`.
 */
export class UnrepresentableAmountError extends Error {
  readonly minorUnits: number;
  readonly currency: string;

  constructor(minorUnits: number, currency: string) {
    super(
      `Amount ${minorUnits} minor units of ${currency} is not a whole number of ` +
        `${currency} major units, so it cannot be charged exactly.`,
    );
    this.name = "UnrepresentableAmountError";
    this.minorUnits = minorUnits;
    this.currency = currency;
  }
}

/**
 * Minor units → major units, for the value **sent to** the provider.
 *
 * Exact division only. An inexact result throws {@link UnrepresentableAmountError}
 * rather than rounding, because both roundings are wrong in a way that reaches a
 * customer: `1 → 0` is a free ticket and `99 → 1` is a 1% overcharge.
 *
 * @param minorUnits integer minor units, as stored by PRD §7.2
 * @param currency   the tier's ISO 4217 code, used only for the error message
 */
export function minorUnitsToMajorUnits(minorUnits: number, currency: string): number {
  const major = minorUnits / MINOR_UNITS_PER_MAJOR;

  if (!Number.isInteger(major)) {
    throw new UnrepresentableAmountError(minorUnits, currency);
  }

  return major;
}

/**
 * Major units → minor units, for an amount **read back from** the provider.
 *
 * The mirror of {@link minorUnitsToMajorUnits}, with the same refusal to round,
 * and it is the direction that matters most for money already taken: a provider
 * amount of `199.99` Naira cannot be stored as whole kobo, and guessing which way
 * to round would either confirm a ticket for less than was paid or overstate it.
 *
 * Rejects a non-integer provider amount too — Flutterwave documents `amount` as
 * an integer, so a fractional value is a provider contract change and must not
 * be silently truncated.
 */
export function majorUnitsToMinorUnits(majorUnits: number, currency: string): number {
  if (!Number.isInteger(majorUnits)) {
    throw new UnrepresentableAmountError(Math.round(majorUnits * 100), currency);
  }

  const minor = majorUnits * MINOR_UNITS_PER_MAJOR;

  if (!Number.isSafeInteger(minor)) {
    throw new UnrepresentableAmountError(majorUnits, currency);
  }

  return minor;
}

/** The one message for an unsupported currency, wherever it is caught. */
export const UNPRICABLE_CURRENCY_MESSAGE =
  "Tickets cannot be priced in this currency, because prices are held in minor units " +
  "and this currency's minor unit is not one hundredth of it.";

/** The one message for a price that will not convert, wherever it is caught. */
export const UNREPRESENTABLE_PRICE_MESSAGE =
  "Must be a whole multiple of 100 so it can be charged exactly.";

/**
 * Assert that a tier's price can be charged exactly in its currency (R-6).
 *
 * ## Why this is one function and not four copies of the check
 *
 * R-6's rule has to hold in every layer that first *knows* a price and currency:
 * tier creation (so an unsellable tier never exists — R-6's stated place), tier
 * edit (a PATCH can create the same fault after the fact), registration (before a
 * hold is taken), and again inside the transaction that writes the attempt (because
 * the price may have been edited in the gap). Each of those is a genuine,
 * separately-necessary check, and each would otherwise carry its own copy of two
 * rules and its own wording — so a fix to one would leave three stale.
 *
 * ## Why it throws a `ValidationError`
 *
 * Because the fault is the *organiser's* to fix and it is attributable to a
 * request field, PRD §11/§15 want a `400` naming `currency` or
 * `price_minor_units`. Throwing the domain error here is what lets every call site
 * produce that same `400` with the same field detail without each one knowing the
 * field names. The currency is checked first because an unrepresentable price in an
 * unsupported currency is the currency's fault, and reporting the price would send
 * the organiser to fix the wrong field.
 */
export function requireChargeableTierPricing(currency: string, priceMinorUnits: number): void {
  if (!isPricableCurrency(currency)) {
    throw new ValidationError(UNPRICABLE_CURRENCY_MESSAGE, {
      currency: [
        `${currency.trim().toUpperCase()} is not supported. Tickets can currently be ` +
          `priced only in currencies whose minor unit is one hundredth of the major unit.`,
      ],
    });
  }

  try {
    minorUnitsToMajorUnits(priceMinorUnits, currency);
  } catch (error) {
    if (error instanceof UnrepresentableAmountError) {
      throw new ValidationError(UNREPRESENTABLE_PRICE_MESSAGE, {
        price_minor_units: [`${UNREPRESENTABLE_PRICE_MESSAGE} The price is in ${currency}.`],
      });
    }

    throw error;
  }
}
