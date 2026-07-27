import type { GraphNode, GraphRel, NodeLabel } from '@devloop/shared';
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';
import { useEffect, useRef } from 'react';

export const labelColors: Record<NodeLabel, string> = {
  Project: '#61d5ff',
  Task: '#f5b942',
  Wiki: '#af91ff',
  Person: '#ff7a90',
  Comment: '#91a4b7',
  Concept: '#58d6a8',
  Decision: '#ff8f5a',
};

const labelNames: Record<NodeLabel, string> = {
  Project: '프로젝트',
  Task: '업무',
  Wiki: '위키',
  Person: '담당자',
  Comment: '댓글',
  Concept: '개념',
  Decision: '결정',
};

export const legendItems = Object.entries(labelColors).map(([label, color]) => ({
  label: label as NodeLabel,
  name: labelNames[label as NodeLabel],
  color,
}));

type GraphCanvasProps = {
  nodes: GraphNode[];
  relationships: GraphRel[];
  evidenceIds: Set<string>;
  focusedNodeId: string | null;
  onNodeClick: (nodeId: string) => void;
  includeIsolatedNodes?: boolean;
};

export function GraphCanvas({
  nodes,
  relationships,
  evidenceIds,
  focusedNodeId,
  onNodeClick,
  includeIsolatedNodes = false,
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const clickHandlerRef = useRef(onNodeClick);

  useEffect(() => {
    clickHandlerRef.current = onNodeClick;
  }, [onNodeClick]);

  useEffect(() => {
    if (!containerRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      minZoom: 0.45,
      maxZoom: 2.2,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(color)',
            'border-color': '#d9f3ff',
            'border-width': 1,
            color: '#f4fbff',
            height: 'data(size)',
            width: 'data(size)',
            label: '',
            'font-family': 'Avenir Next, Pretendard, sans-serif',
            'font-size': 11,
            'font-weight': 600,
            'text-background-color': '#0b1724',
            'text-background-opacity': 0.92,
            'text-background-padding': '5px',
            'text-background-shape': 'roundrectangle',
            'text-margin-y': -14,
            'transition-property': 'opacity, border-width, border-color',
            'transition-duration': 180,
          },
        },
        { selector: 'node.hovered', style: { label: 'data(display)', 'z-index': 10 } },
        {
          selector: 'node.context',
          style: { opacity: 0.28, 'border-opacity': 0.4 },
        },
        {
          selector: 'node.focused',
          style: {
            opacity: 1,
            'border-color': '#ffffff',
            'border-width': 5,
            label: 'data(display)',
            'z-index': 20,
          },
        },
        {
          selector: 'edge',
          style: {
            width: 2.2,
            'line-color': '#7895a8',
            'target-arrow-color': '#7895a8',
            'target-arrow-shape': 'triangle',
            'arrow-scale': 0.9,
            'curve-style': 'bezier',
            opacity: 0.72,
          },
        },
        {
          selector: 'edge.evidence',
          style: {
            width: 3,
            'line-color': '#b7e7f5',
            'target-arrow-color': '#b7e7f5',
            opacity: 0.96,
          },
        },
        {
          selector: 'edge.context',
          style: {
            width: 2,
            'line-color': '#607f91',
            'target-arrow-color': '#607f91',
            opacity: 0.42,
          },
        },
      ],
    });

    cy.on('mouseover', 'node', (event) => event.target.addClass('hovered'));
    cy.on('mouseout', 'node', (event) => event.target.removeClass('hovered'));
    cy.on('tap', 'node', (event) => clickHandlerRef.current(event.target.id()));
    cyRef.current = cy;

    const resizeObserver = new ResizeObserver(() => cy.resize());
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const nodeIds = new Set(nodes.map((node) => node.id));
    const visibleRelationships = relationships.filter(
      (relationship) =>
        nodeIds.has(relationship.startId) && nodeIds.has(relationship.endId),
    );
    const connectedNodeIds = new Set(
      visibleRelationships.flatMap((relationship) => [
        relationship.startId,
        relationship.endId,
      ]),
    );
    const visibleNodes = includeIsolatedNodes
      ? nodes
      : nodes.filter((node) => connectedNodeIds.has(node.id));
    const elements: ElementDefinition[] = [
      ...visibleNodes.map((node) => ({
        data: {
          id: node.id,
          display: node.display,
          color: labelColors[node.label],
          size: node.label === 'Decision' ? 44 : node.label === 'Task' ? 38 : 30,
        },
        classes: evidenceIds.has(node.id) ? 'evidence' : 'context',
      })),
      ...visibleRelationships.map((relationship) => ({
        data: {
          id: relationship.id,
          source: relationship.startId,
          target: relationship.endId,
        },
        classes:
          evidenceIds.has(relationship.startId) && evidenceIds.has(relationship.endId)
            ? 'evidence'
            : 'context',
      })),
    ];

    cy.elements().remove();
    cy.add(elements);
    if (visibleNodes.length > 0) {
      cy.layout({
        name: 'cose',
        animate: false,
        fit: true,
        padding: 72,
        nodeRepulsion: () => 6800,
        idealEdgeLength: () => 92,
      }).run();
    }
  }, [evidenceIds, includeIsolatedNodes, nodes, relationships]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !focusedNodeId) return;
    cy.nodes().removeClass('focused');
    const node = cy.getElementById(focusedNodeId);
    if (node.empty()) return;
    node.addClass('focused');
    cy.animate({ center: { eles: node }, zoom: 1.35, duration: 420 });
  }, [focusedNodeId, nodes]);

  return <div ref={containerRef} className="graph-canvas" aria-label="근거 지식그래프" />;
}
