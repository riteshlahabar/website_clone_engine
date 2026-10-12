import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useState } from "react";
import type { BlockMeta, Section } from "../types.ts";
import { uid } from "../types.ts";

function ContentFields({
  block,
  section,
  onChange,
}: {
  block: BlockMeta;
  section: Section;
  onChange: (content: Record<string, string>) => void;
}) {
  const set = (key: string, value: string) =>
    onChange({ ...section.content, [key]: value });

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {block.params.map((param) => {
        const value = section.content[param.key] ?? "";
        const common =
          "w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:border-slate-900 focus:outline-none";

        return (
          <label
            key={param.key}
            className={param.type === "textarea" ? "sm:col-span-2" : undefined}
          >
            <span className="mb-1 block text-xs font-medium text-slate-600">
              {param.label}
            </span>
            {param.type === "textarea" ? (
              <textarea
                rows={2}
                className={common}
                value={value}
                placeholder={param.default}
                onChange={(event) => set(param.key, event.target.value)}
              />
            ) : param.type === "color" ? (
              <span className="flex items-center gap-2">
                <input
                  type="color"
                  className="size-8 shrink-0 cursor-pointer rounded border border-slate-300"
                  value={value || param.default}
                  onChange={(event) => set(param.key, event.target.value)}
                />
                <input
                  className={common}
                  value={value}
                  placeholder={
                    param.brand ? `${param.default} (from brand)` : param.default
                  }
                  onChange={(event) => set(param.key, event.target.value)}
                />
              </span>
            ) : (
              <input
                className={common}
                value={value}
                placeholder={param.default}
                onChange={(event) => set(param.key, event.target.value)}
              />
            )}
          </label>
        );
      })}
    </div>
  );
}

function SortableSection({
  section,
  block,
  onChange,
  onRemove,
}: {
  section: Section;
  block: BlockMeta | undefined;
  onChange: (next: Section) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: section.uid });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`rounded-lg border border-slate-200 bg-white ${
        isDragging ? "opacity-60 shadow-lg" : ""
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label="Drag to reorder"
          className="cursor-grab px-1 text-slate-400 hover:text-slate-700 active:cursor-grabbing"
        >
          ⠿
        </button>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="min-w-0 flex-1 text-left"
        >
          <span className="text-sm font-medium">{block?.name ?? section.block}</span>
          <span className="ml-2 truncate text-xs text-slate-500">
            {block?.description}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="rounded px-2 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-300 hover:bg-slate-50"
        >
          {open ? "Hide" : "Edit text"}
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove section"
          className="rounded px-2 py-1 text-xs font-medium text-rose-700 ring-1 ring-rose-200 hover:bg-rose-50"
        >
          Remove
        </button>
      </div>

      {open && block ? (
        <div className="border-t border-slate-100 px-3 py-3">
          <ContentFields
            block={block}
            section={section}
            onChange={(content) => onChange({ ...section, content })}
          />
          <p className="mt-2 text-xs text-slate-500">
            Leave a field empty to use the placeholder shown. Colours left empty follow
            your brand palette.
          </p>
        </div>
      ) : null}
    </li>
  );
}

export default function SectionList({
  sections,
  blocks,
  onChange,
}: {
  sections: Section[];
  blocks: BlockMeta[];
  onChange: (next: Section[]) => void;
}) {
  const [picking, setPicking] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = sections.findIndex((section) => section.uid === active.id);
    const to = sections.findIndex((section) => section.uid === over.id);
    if (from === -1 || to === -1) return;
    onChange(arrayMove(sections, from, to));
  };

  const addSection = (blockId: string) => {
    onChange([...sections, { uid: uid(), block: blockId, content: {} }]);
    setPicking(false);
  };

  return (
    <div>
      {sections.length === 0 ? (
        <p className="rounded-md bg-slate-50 px-3 py-4 text-sm text-slate-500">
          No sections yet. Add one below — the page is built from these, top to bottom.
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={sections.map((section) => section.uid)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="space-y-2">
              {sections.map((section, index) => (
                <SortableSection
                  key={section.uid}
                  section={section}
                  block={blocks.find((block) => block.id === section.block)}
                  onChange={(next) => {
                    const copy = [...sections];
                    copy[index] = next;
                    onChange(copy);
                  }}
                  onRemove={() =>
                    onChange(sections.filter((item) => item.uid !== section.uid))
                  }
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      {picking ? (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-2">
          <div className="grid gap-2 sm:grid-cols-2">
            {blocks.map((block) => (
              <button
                key={block.id}
                type="button"
                onClick={() => addSection(block.id)}
                className="rounded-md border border-slate-200 bg-white px-3 py-2 text-left hover:border-slate-900"
              >
                <span className="block text-sm font-medium">{block.name}</span>
                <span className="block text-xs text-slate-500">{block.description}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setPicking(false)}
            className="mt-2 text-xs font-medium text-slate-600 hover:underline"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setPicking(true)}
          className="mt-3 rounded-md border border-dashed border-slate-400 px-3 py-2 text-sm font-medium text-slate-700 hover:border-slate-900 hover:bg-slate-50"
        >
          + Add section
        </button>
      )}
    </div>
  );
}
