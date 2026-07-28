import type { GraphStatsResponse, NodeLabel, OntologyResponse, RelationshipType } from "@devloop/shared";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import { useEffect, useRef } from "react";
import { labelColors } from "./GraphCanvas";

export type SchemaSelection = { kind: "label"; value: NodeLabel } | { kind: "relationship"; value: RelationshipType };

type SchemaCanvasVariant = "operational" | "contract";

const positions: Record<NodeLabel, { x: number; y: number }> = {
  Project: { x: 90, y: 280 },
  Task: { x: 320, y: 190 },
  Wiki: { x: 320, y: 410 },
  Person: { x: 585, y: 70 },
  Comment: { x: 585, y: 210 },
  Decision: { x: 585, y: 370 },
  Concept: { x: 840, y: 280 },
};

const loopAnchorOffsets: Record<string, { x: number; y: number }> = {
  "Task-REFERENCES": { x: -90, y: -105 },
  "Task-CHILD_OF": { x: 0, y: -130 },
  "Task-RELATES_TO": { x: 90, y: -105 },
  "Wiki-CHILD_OF": { x: -95, y: 95 },
  "Concept-DEPENDS_ON": { x: 90, y: -105 },
};

export function SchemaCanvas({
  ontology,
  stats,
  onSelect,
  variant = "operational",
}: {
  ontology: OntologyResponse;
  stats?: GraphStatsResponse;
  onSelect?: (selection: SchemaSelection) => void;
  variant?: SchemaCanvasVariant;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const selectHandlerRef = useRef(onSelect);

  useEffect(() => {
    selectHandlerRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    if (!containerRef.current) return;

    const relationshipElements: ElementDefinition[] = ontology.relationships.flatMap((definition) =>
      definition.directions.flatMap((direction, index): ElementDefinition[] => {
        const edgeData = {
          type: definition.type,
          count: stats?.relationships[definition.type] ?? 0,
        };
        if (direction.from !== direction.to) {
          return [
            {
              data: {
                id: `${definition.type}-${index}`,
                source: direction.from,
                target: direction.to,
                label: definition.type,
                ...edgeData,
              },
            },
          ];
        }

        const anchorId = `${direction.from}-${definition.type}-anchor`;
        const offset = loopAnchorOffsets[`${direction.from}-${definition.type}`] ?? { x: 0, y: -110 };
        const sourcePosition = positions[direction.from];
        return [
          {
            data: { id: anchorId, color: "#000000", label: "" },
            classes: "loop-anchor",
            position: {
              x: sourcePosition.x + offset.x,
              y: sourcePosition.y + offset.y,
            },
          },
          {
            data: {
              id: `${definition.type}-${index}-out`,
              source: direction.from,
              target: anchorId,
              label: definition.type,
              ...edgeData,
            },
            classes: "loop-segment loop-out",
          },
          {
            data: {
              id: `${definition.type}-${index}-in`,
              source: anchorId,
              target: direction.to,
              label: "",
              ...edgeData,
            },
            classes: "loop-segment loop-in",
          },
        ];
      }),
    );
    const elements: ElementDefinition[] = [
      ...ontology.nodes.map((definition) => ({
        data: {
          id: definition.label,
          label:
            variant === "operational" ? `${definition.label}\n${(stats?.nodes[definition.label] ?? 0).toLocaleString("ko-KR")}` : definition.label,
          color: labelColors[definition.label],
        },
        classes: definition.label === "Concept" || definition.label === "Person" ? "round" : "",
        position: positions[definition.label],
      })),
      ...relationshipElements,
    ];

    const contractMode = variant === "contract";
    const cy = cytoscape({
      container: containerRef.current,
      elements,
      minZoom: 0.55,
      maxZoom: 1.8,
      layout: { name: "preset", fit: true, padding: 58 },
      style: [
        {
          selector: "node",
          style: {
            shape: "roundrectangle",
            width: contractMode ? 108 : 116,
            height: contractMode ? 58 : 66,
            "background-color": contractMode ? "#f8f8f3" : "#102432",
            "border-color": "data(color)",
            "border-width": contractMode ? 4 : 3,
            color: contractMode ? "#17303b" : "#f1f8fb",
            label: "data(label)",
            "font-family": "Avenir Next, Pretendard, sans-serif",
            "font-size": contractMode ? 12 : 13,
            "font-weight": 700,
            "text-wrap": "wrap",
            "text-valign": "center",
            "text-halign": "center",
            "line-height": 1.4,
            "overlay-opacity": 0,
          },
        },
        { selector: "node.round", style: { shape: "ellipse" } },
        {
          selector: "node.loop-anchor",
          style: {
            width: 2,
            height: 2,
            opacity: 0,
            label: "",
            events: "no",
          },
        },
        {
          selector: "node.hovered",
          style: {
            "background-color": "#19384b",
            "border-width": 5,
          },
        },
        {
          selector: "edge",
          style: {
            width: 1.7,
            "line-color": contractMode ? "#637f8a" : "#59788b",
            "target-arrow-color": contractMode ? "#3e6774" : "#8bb4c8",
            "target-arrow-shape": "triangle",
            "arrow-scale": 0.82,
            "curve-style": "bezier",
            "control-point-step-size": 38,
            label: contractMode ? "data(label)" : "",
            color: "#294550",
            "font-family": "SFMono-Regular, Consolas, monospace",
            "font-size": 7.5,
            "font-weight": 700,
            "text-background-color": "#f2f2ec",
            "text-background-opacity": contractMode ? 0.94 : 0,
            "text-background-padding": "3px",
            "text-rotation": contractMode ? "autorotate" : "none",
            opacity: contractMode ? 0.82 : 0.7,
            "overlay-opacity": 0,
          },
        },
        {
          selector: "edge.loop-segment",
          style: {
            "curve-style": "bezier",
            "control-point-step-size": 24,
          },
        },
        {
          selector: "edge.loop-out",
          style: {
            "target-arrow-shape": "none",
          },
        },
        {
          selector: "edge.hovered",
          style: {
            width: 3,
            "line-color": "#b7e7f5",
            "target-arrow-color": "#b7e7f5",
            label: "data(label)",
            color: "#eaf8ff",
            "font-size": 9,
            "font-weight": 700,
            "text-background-color": "#0b1724",
            "text-background-opacity": 0.95,
            "text-background-padding": "4px",
            opacity: 1,
          },
        },
      ],
    });

    cy.on("mouseover", "node, edge", (event) => event.target.addClass("hovered"));
    cy.on("mouseout", "node, edge", (event) => event.target.removeClass("hovered"));
    if (onSelect) {
      cy.on("tap", "node", (event) => {
        selectHandlerRef.current?.({ kind: "label", value: event.target.id() as NodeLabel });
      });
      cy.on("tap", "edge", (event) => {
        selectHandlerRef.current?.({
          kind: "relationship",
          value: event.target.data("type") as RelationshipType,
        });
      });
    }
    cyRef.current = cy;

    const resizeObserver = new ResizeObserver(() => {
      cy.resize();
      cy.fit(cy.elements(), 58);
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      cy.destroy();
      cyRef.current = null;
    };
  }, [ontology, onSelect, stats, variant]);

  return (
    <div
      ref={containerRef}
      className={`schema-canvas ${variant === "contract" ? "contract-canvas" : ""}`}
      aria-label={variant === "contract" ? "온톨로지 계약 관계 도식" : "온톨로지 구조 다이어그램"}
    />
  );
}
