"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface AccordionContextValue {
  value: string[];
  onValueChange: (value: string[]) => void;
  type: "single" | "multiple";
}

const AccordionContext = React.createContext<AccordionContextValue | null>(null);

function useAccordion() {
  const context = React.useContext(AccordionContext);
  if (!context) {
    throw new Error("Accordion components must be used within an Accordion");
  }
  return context;
}

interface AccordionProps {
  type?: "single" | "multiple";
  defaultValue?: string[];
  children: React.ReactNode;
  className?: string;
}

export function Accordion({
  type = "single",
  defaultValue = [],
  children,
  className,
}: AccordionProps) {
  const [value, setValue] = React.useState<string[]>(defaultValue);

  const onValueChange = React.useCallback(
    (itemValue: string[]) => {
      setValue(itemValue);
    },
    []
  );

  return (
    <AccordionContext.Provider value={{ value, onValueChange, type }}>
      <div className={cn("divide-y divide-gray-200", className)}>{children}</div>
    </AccordionContext.Provider>
  );
}

interface AccordionItemContextValue {
  value: string;
  isOpen: boolean;
  toggle: () => void;
}

const AccordionItemContext = React.createContext<AccordionItemContextValue | null>(null);

function useAccordionItem() {
  const context = React.useContext(AccordionItemContext);
  if (!context) {
    throw new Error("AccordionItem components must be used within an AccordionItem");
  }
  return context;
}

interface AccordionItemProps {
  value: string;
  children: React.ReactNode;
  className?: string;
}

export function AccordionItem({ value, children, className }: AccordionItemProps) {
  const accordion = useAccordion();
  const isOpen = accordion.value.includes(value);

  const toggle = React.useCallback(() => {
    if (accordion.type === "single") {
      accordion.onValueChange(isOpen ? [] : [value]);
    } else {
      accordion.onValueChange(
        isOpen
          ? accordion.value.filter((v) => v !== value)
          : [...accordion.value, value]
      );
    }
  }, [accordion, isOpen, value]);

  return (
    <AccordionItemContext.Provider value={{ value, isOpen, toggle }}>
      <div className={cn("py-4", className)}>{children}</div>
    </AccordionItemContext.Provider>
  );
}

interface AccordionTriggerProps {
  children: React.ReactNode;
  className?: string;
}

export function AccordionTrigger({ children, className }: AccordionTriggerProps) {
  const { isOpen, toggle, value } = useAccordionItem();

  return (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={isOpen}
      aria-controls={`accordion-content-${value}`}
      className={cn(
        "flex w-full items-center justify-between text-left font-medium text-gray-900 hover:text-gray-700 transition-colors",
        className
      )}
    >
      {children}
      <ChevronDown
        className={cn(
          "h-5 w-5 text-gray-500 transition-transform duration-200",
          isOpen && "rotate-180"
        )}
        aria-hidden="true"
      />
    </button>
  );
}

interface AccordionContentProps {
  children: React.ReactNode;
  className?: string;
}

export function AccordionContent({ children, className }: AccordionContentProps) {
  const { isOpen, value } = useAccordionItem();

  return (
    <div
      id={`accordion-content-${value}`}
      role="region"
      hidden={!isOpen}
      className={cn(
        "overflow-hidden transition-all duration-200",
        isOpen ? "mt-3" : "mt-0 h-0",
        className
      )}
    >
      {isOpen && <div className="text-gray-600">{children}</div>}
    </div>
  );
}
