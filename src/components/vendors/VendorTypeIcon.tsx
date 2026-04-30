import {
  Store,
  Utensils,
  Palette,
  Music,
  ShoppingBag,
  Coffee,
  Wrench,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

/**
 * Free-tier visual placeholder where the logo would render on Enhanced
 * profiles. Maps the loose `vendor_type` string to a representative icon.
 * Falls back to `Store` when no mapping matches — the placeholder should
 * never feel like a missing image.
 */
const ICON_MAP: Record<string, LucideIcon> = {
  Food: Utensils,
  "Food & Beverage": Utensils,
  Beverage: Coffee,
  Crafts: Palette,
  Art: Palette,
  Music: Music,
  Apparel: ShoppingBag,
  Retail: ShoppingBag,
  Services: Wrench,
  Beauty: Sparkles,
};

interface Props {
  vendorType: string | null;
  className?: string;
  size?: number;
}

export function VendorTypeIcon({ vendorType, className = "", size = 48 }: Props) {
  const Icon = (vendorType && ICON_MAP[vendorType]) || Store;
  return <Icon className={className} width={size} height={size} aria-hidden="true" />;
}
