import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";
import { z } from "zod";

import { setupStripeCatalog } from "../../scripts/setup-stripe-catalog";

const PRO_MONTHLY_CENTS = 2500;
const PRO_YEARLY_CENTS = 20400;
const MAX_MONTHLY_CENTS = 12000;
const MAX_YEARLY_CENTS = 120000;
const TOPUP_CENTS = 10;
const SUBSCRIPTION_PRICE_COUNT = 4;

void test("catalog creates all four immutable plan prices and the unchanged top-up", async (t) => {
  const stripe = new Stripe("sk_test_mock_only");
  t.mock.method(stripe.prices, "list", async () => ({ data: [] }));
  const create = t.mock.method(stripe.prices, "create", async (input: Stripe.PriceCreateParams) =>
    z.custom<Stripe.Price>().parse({
      id: `price_${input.lookup_key ?? ""}`,
      product: input.product ?? `prod_${input.product_data?.name ?? ""}`,
      ...input,
    }),
  );
  await setupStripeCatalog(stripe);
  assert.deepEqual(
    create.mock.calls.map((call) => {
      const input = call.arguments[0];

      return [input.lookup_key, input.unit_amount, input.recurring?.interval];
    }),
    [
      ["readymeet_pro_monthly", PRO_MONTHLY_CENTS, "month"],
      ["readymeet_pro_yearly", PRO_YEARLY_CENTS, "year"],
      ["readymeet_max_monthly", MAX_MONTHLY_CENTS, "month"],
      ["readymeet_max_yearly", MAX_YEARLY_CENTS, "year"],
      ["readymeet_credit_topup", TOPUP_CENTS, undefined],
    ],
  );
  assert.equal(create.mock.calls[1]?.arguments[0].product, "prod_Ready Pro");
  assert.equal(create.mock.calls[3]?.arguments[0].product, "prod_Ready Max");
});

void test("changed immutable prices transfer lookup keys; unchanged prices are reused", async (t) => {
  const stripe = new Stripe("sk_test_mock_only");
  t.mock.method(stripe.prices, "list", async (input?: Stripe.PriceListParams) => ({
    data: [
      z.custom<Stripe.Price>().parse({
        id: "price_old",
        product: "prod_existing",
        unit_amount: input?.lookup_keys?.[0] === "readymeet_credit_topup" ? TOPUP_CENTS : 1,
      }),
    ],
  }));
  const create = t.mock.method(stripe.prices, "create", async (input: Stripe.PriceCreateParams) =>
    z.custom<Stripe.Price>().parse({ id: "price_replacement", product: "prod_existing", ...input }),
  );
  await setupStripeCatalog(stripe);
  assert.equal(create.mock.callCount(), SUBSCRIPTION_PRICE_COUNT);
  create.mock.calls.forEach((call) => {
    assert.equal(call.arguments[0].transfer_lookup_key, true);
    assert.equal(call.arguments[0].product, "prod_existing");
  });
});
