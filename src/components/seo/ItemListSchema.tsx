interface ItemListSchemaProps {
  name: string;
  description?: string;
  items: Array<{ name: string; url: string }>;
}

export function ItemListSchema({ name, description, items }: ItemListSchemaProps) {
  const capped = items.slice(0, 30);

  const schema = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name,
    description: description || undefined,
    numberOfItems: capped.length,
    itemListElement: capped.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      url: item.url,
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
