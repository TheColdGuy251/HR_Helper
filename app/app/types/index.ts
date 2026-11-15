export type NodeType = 'input' | 'condition' | 'ai' | 'action' | 'output';

interface BaseNodeData {
  label: string;
}

export interface InputNodeData extends BaseNodeData { text: string; }
export interface ConditionNodeData extends BaseNodeData { compareValue: string; }
export interface OutputNodeData extends BaseNodeData { result: string; }
export interface AINodeData extends BaseNodeData { prompt: string; }
export interface ActionNodeData extends BaseNodeData { actionType: string; }

export type NodeData = InputNodeData | ConditionNodeData | OutputNodeData | AINodeData | ActionNodeData;

export interface AppNode {
  id: string;
  type: NodeType;
  position: { x: number; y: number };
  data: NodeData;
}

export interface AppEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

export interface AppGraph {
  nodes: AppNode[];
  edges: AppEdge[];
}

export const NODE_CATEGORIES = [
  { type: 'input', title: 'Вход', icon: '⚡' },
  { type: 'condition', title: 'Условие', icon: '🔀' },
  { type: 'output', title: 'Выход', icon: '✅' },
] as const;