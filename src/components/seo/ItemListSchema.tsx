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
  totalCount?: number;
  order?: ItemListOrder;
  asCollectionPage?: boolean;
  pageUrl?: string;
}

export function ItemListSchema({
  name,
  description,
  items,
  totalCount,
  order = "ascending",
  asCollectionPage,
  pageUrl,
}: ItemListSchemaProps) {
  const capped = items.slice(0, 30);

  const itemList = {
    "@type": "ItemList",
    name,
    description: description || undefined,
    numberOfItems: totalCount ?? capped.length,
    itemListOrder: itemListOrderMap[order],
    itemListElement: capped.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      url: item.url,
      image: item.image || undefined,
    })),
  };

  const schema = asCollectionPage
    ? {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        name,
        description: description || undefined,
        url: pageUrl || undefined,
        mainEntity: itemList,
      }
    : {
        "@context": "https://schema.org",
        ...itemList,
      };

  const cleanSchema = JSON.parse(JSON.stringify(schema));

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(cleanSchema) }}
    />
  );
}
