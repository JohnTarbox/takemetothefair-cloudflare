type ItemListOrder = "ascending" | "descending" | "unordered";

const itemListOrderMap: Record<ItemListOrder, string> = {
  ascending: "https://schema.org/ItemListOrderAscending",
  descending: "https://schema.org/ItemListOrderDescending",
  unordered: "https://schema.org/ItemListUnordered",
};

interface ItemListSchemaProps {
  name: string;
  description?: string;
  items: Array<{ name: string; url: string; image?: string | null }>;
  order?: ItemListOrder;
}

export function ItemListSchema({ name, description, items, order = "ascending" }: ItemListSchemaProps) {
  const capped = items.slice(0, 30);

  const schema = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name,
    description: description || undefined,
    numberOfItems: capped.length,
    itemListOrder: itemListOrderMap[order],
    itemListElement: capped.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      url: item.url,
      image: item.image || undefined,
    })),
  };

  const cleanSchema = JSON.parse(JSON.stringify(schema));

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(cleanSchema) }}
    />
  );
}
