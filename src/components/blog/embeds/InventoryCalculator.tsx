"use client";

import { useState } from "react";
import Link from "next/link";

const tiers = [
  { label: "$5–$15 (impulse)", pct: 0.25, avg: 10 },
  { label: "$20–$50 (core)", pct: 0.5, avg: 35 },
  { label: "$75+ (anchor)", pct: 0.25, avg: 90 },
];

const categoryMultipliers = {
  small: {
    label: "Small / lightweight (jewelry, stickers, candles, soap)",
    min: 3,
    max: 4,
  },
  mid: {
    label: "Mid-size handmade (pottery, bags, boards, knitwear)",
    min: 2,
    max: 3,
  },
  large: {
    label: "Large / high-value (furniture, art, quilts)",
    min: 1.5,
    max: 2,
  },
} as const;

type CategoryKey = keyof typeof categoryMultipliers;

const fairScales = [
  {
    label: "Small community fair (~500 attendees)",
    attendance: 500,
    days: 1,
    conversion: 0.02,
  },
  {
    label: "Medium fair (~2,000 attendees)",
    attendance: 2000,
    days: 2,
    conversion: 0.015,
  },
  {
    label: "Large agricultural fair (~10,000+)",
    attendance: 10000,
    days: 3,
    conversion: 0.012,
  },
  { label: "Major event (50,000+)", attendance: 50000, days: 5, conversion: 0.01 },
];

function fmt(n: number) {
  return Math.round(n).toLocaleString();
}
function fmtDollar(n: number) {
  return "$" + fmt(n);
}

export function InventoryCalculator() {
  const [salesGoal, setSalesGoal] = useState(600);
  const [avgPrice, setAvgPrice] = useState(25);
  const [category, setCategory] = useState<CategoryKey>("mid");
  const [fairScale, setFairScale] = useState<number | null>(null);
  const [daysVending, setDaysVending] = useState(1);

  const mult = categoryMultipliers[category];
  const midMult = (mult.min + mult.max) / 2;

  const unitsToBring = Math.round((salesGoal / avgPrice) * midMult);
  const dollarsToBring = unitsToBring * avgPrice;

  const tierBreakdown = tiers.map((t) => ({
    ...t,
    units: Math.round(unitsToBring * t.pct),
    value: Math.round(unitsToBring * t.pct * t.avg),
  }));

  const scaleCheck = fairScale !== null ? fairScales[fairScale] : null;
  const estimatedSales = scaleCheck
    ? Math.round(
        scaleCheck.attendance * scaleCheck.conversion * Math.min(daysVending, scaleCheck.days)
      )
    : null;

  return (
    <div className="not-prose my-8 w-full">
      <div className="bg-white rounded-2xl shadow-sm border border-stone-100 overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-r from-amber to-amber-dark px-6 py-5">
          <h2 className="text-2xl font-bold text-navy">Craft Fair Inventory Calculator</h2>
          <p className="text-navy/80 mt-1 text-sm">
            Figure out how much to bring based on your goals, product type, and fair size.
          </p>
        </div>

        <div className="p-6 space-y-6">
          {/* Sales Goal */}
          <div>
            <label
              htmlFor="inv-sales-goal"
              className="block text-sm font-semibold text-stone-900 mb-2"
            >
              Your sales goal for this fair
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-600 font-medium">
                $
              </span>
              <input
                id="inv-sales-goal"
                type="number"
                min={0}
                step={50}
                value={salesGoal}
                onChange={(e) => setSalesGoal(Math.max(0, +e.target.value))}
                className="w-full pl-8 pr-4 py-3 border border-stone-100 rounded-lg text-lg focus:outline-none focus:ring-2 focus:ring-amber focus:border-amber"
              />
            </div>
          </div>

          {/* Average Price */}
          <div>
            <label
              htmlFor="inv-avg-price"
              className="block text-sm font-semibold text-stone-900 mb-2"
            >
              Average item price
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-600 font-medium">
                $
              </span>
              <input
                id="inv-avg-price"
                type="number"
                min={1}
                step={5}
                value={avgPrice}
                onChange={(e) => setAvgPrice(Math.max(1, +e.target.value))}
                className="w-full pl-8 pr-4 py-3 border border-stone-100 rounded-lg text-lg focus:outline-none focus:ring-2 focus:ring-amber focus:border-amber"
              />
            </div>
          </div>

          {/* Product Category */}
          <div>
            <div className="block text-sm font-semibold text-stone-900 mb-2">What do you sell?</div>
            <div className="space-y-2" role="radiogroup" aria-label="Product category">
              {(
                Object.entries(categoryMultipliers) as [
                  CategoryKey,
                  (typeof categoryMultipliers)[CategoryKey],
                ][]
              ).map(([key, val]) => (
                <label
                  key={key}
                  className={`flex items-center p-3 rounded-lg border cursor-pointer transition-colors ${
                    category === key
                      ? "border-amber bg-amber-light"
                      : "border-stone-100 hover:border-stone-300"
                  }`}
                >
                  <input
                    type="radio"
                    name="inv-category"
                    value={key}
                    checked={category === key}
                    onChange={() => setCategory(key)}
                    className="mr-3 accent-amber"
                  />
                  <div>
                    <span className="text-sm text-stone-900">{val.label}</span>
                    <span className="text-xs text-stone-600 ml-2">
                      ({val.min}–{val.max}x multiplier)
                    </span>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Result Card */}
          <div className="bg-amber-light/60 border border-amber/40 rounded-xl p-5">
            <h3 className="text-lg font-bold text-navy mb-3">Your Inventory Plan</h3>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div className="bg-white rounded-lg p-4 text-center shadow-sm">
                <div className="text-3xl font-bold text-amber-dark">{fmt(unitsToBring)}</div>
                <div className="text-xs text-stone-600 mt-1">items to bring</div>
              </div>
              <div className="bg-white rounded-lg p-4 text-center shadow-sm">
                <div className="text-3xl font-bold text-amber-dark">
                  {fmtDollar(dollarsToBring)}
                </div>
                <div className="text-xs text-stone-600 mt-1">total retail value</div>
              </div>
            </div>

            <h4 className="text-sm font-semibold text-navy mb-2">
              Suggested price tier breakdown:
            </h4>
            <div className="space-y-2">
              {tierBreakdown.map((t, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between bg-white rounded-lg px-4 py-2 shadow-sm"
                >
                  <span className="text-sm text-stone-900">{t.label}</span>
                  <span className="text-sm font-semibold text-stone-900">
                    {t.units} items{" "}
                    <span className="text-stone-600 font-normal">({fmtDollar(t.value)})</span>
                  </span>
                </div>
              ))}
            </div>

            <p className="text-xs text-stone-600 mt-3">
              Based on {fmtDollar(salesGoal)} goal × {midMult}x multiplier (
              {mult.label.split("(")[0].trim().toLowerCase()}) at {fmtDollar(avgPrice)} avg price.
            </p>
          </div>

          {/* Fair Scale Gut-Check */}
          <div className="border-t border-stone-100 pt-6">
            <h3 className="text-lg font-bold text-navy mb-1">Attendance Gut-Check</h3>
            <p className="text-sm text-stone-600 mb-3">
              Optional: pick a fair size to sanity-check your numbers against expected foot traffic.
            </p>

            <div className="space-y-2 mb-4" role="radiogroup" aria-label="Fair size">
              {fairScales.map((fs, i) => (
                <label
                  key={i}
                  className={`flex items-center p-3 rounded-lg border cursor-pointer transition-colors ${
                    fairScale === i
                      ? "border-royal bg-brand-blue-light/60"
                      : "border-stone-100 hover:border-stone-300"
                  }`}
                >
                  <input
                    type="radio"
                    name="inv-fair-scale"
                    value={i}
                    checked={fairScale === i}
                    onChange={() => setFairScale(i)}
                    className="mr-3 accent-royal"
                  />
                  <span className="text-sm text-stone-900">{fs.label}</span>
                </label>
              ))}
            </div>

            {fairScale !== null && scaleCheck && estimatedSales !== null && (
              <>
                <div className="mb-3">
                  <label
                    htmlFor="inv-days-vending"
                    className="block text-sm font-semibold text-stone-900 mb-1"
                  >
                    Days you&rsquo;re vending
                  </label>
                  <input
                    id="inv-days-vending"
                    type="number"
                    min={1}
                    max={17}
                    value={daysVending}
                    onChange={(e) => setDaysVending(Math.max(1, Math.min(17, +e.target.value)))}
                    className="w-24 px-3 py-2 border border-stone-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-royal focus:border-royal"
                  />
                </div>

                <div className="bg-brand-blue-light/60 border border-royal/30 rounded-xl p-4">
                  <div className="text-sm text-navy">
                    At a <strong>{scaleCheck.label.toLowerCase()}</strong> over{" "}
                    <strong>
                      {daysVending} day{daysVending > 1 ? "s" : ""}
                    </strong>
                    , expect roughly <strong>{fmt(estimatedSales)} sales</strong> at your booth
                    (1–3% conversion).
                  </div>
                  <div className="mt-2 text-sm">
                    {estimatedSales <= unitsToBring * 0.4 ? (
                      <span className="text-success">
                        Your inventory plan of {fmt(unitsToBring)} items gives you plenty of buffer.
                        You&rsquo;re well-stocked.
                      </span>
                    ) : estimatedSales <= unitsToBring * 0.7 ? (
                      <span className="text-warning">
                        Your inventory plan of {fmt(unitsToBring)} items is in a good range for this
                        fair size. You should have enough variety without overpacking.
                      </span>
                    ) : (
                      <span className="text-danger">
                        Heads up: {fmt(estimatedSales)} estimated sales against {fmt(unitsToBring)}{" "}
                        items is tight. Consider bringing more inventory or raising your sales goal.
                      </span>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Footer: single link back to the companion guide */}
          <div className="border-t border-stone-100 pt-4 text-center">
            <Link
              href="/blog/how-many-items-should-you-bring-to-a-craft-fair-a-simple-formula"
              className="text-sm text-royal hover:underline"
            >
              ← Read the full guide
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
