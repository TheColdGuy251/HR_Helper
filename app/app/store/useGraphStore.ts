import { create } from 'zustand';
import { applyNodeChanges, applyEdgeChanges, addEdge, NodeChange, EdgeChange, Connection } from 'reactflow';
import { AppNode, AppEdge, NodeType, NodeData, InputNodeData, ConditionNodeData, OutputNodeData } from '@/app/types';

interface GraphState {
  nodes: AppNode[];
  edges: AppEdge[];
  selectedNodeId: string | null;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  setSelectedNodeId: (id: string | null) => void;
  updateNodeData: (id: string, newData: Partial<NodeData>) => void;
  addNode: (type: NodeType, position: { x: number; y: number }, customLabel?: string) => void;
}

export const useGraphStore = create<GraphState>((set, get) => ({
  nodes: [],
  edges: [],
  selectedNodeId: null,

  onNodesChange: (changes) => {
    set({ nodes: applyNodeChanges(changes, get().nodes) as AppNode[] });
    const deletedNode = changes.find(c => c.type === 'remove');
    if (deletedNode && (deletedNode as any).id === get().selectedNodeId) {
      set({ selectedNodeId: null });
    }
  },
  onEdgesChange: (changes) => set({ edges: applyEdgeChanges(changes, get().edges) as AppEdge[] }),
  onConnect: (connection) => set({ edges: addEdge(connection, get().edges) as AppEdge[] }),

  setSelectedNodeId: (id) => set({ selectedNodeId: id }),

  updateNodeData: (id, newData) => {
    set({
      nodes: get().nodes.map((node) =>
        node.id === id ? { ...node, data: { ...node.data, ...newData } } : node
      ) as AppNode[],
    });
  },

  addNode: (type, position, customLabel) => {
    let data: NodeData;

    switch (type) {
      case 'input':
        data = { label: customLabel || 'Вход', text: '' } as InputNodeData; // <-- Используем customLabel
        break;
      case 'condition':
        data = { label: customLabel || 'Условие', compareValue: '' } as ConditionNodeData;
        break;
      case 'output':
        data = { label: customLabel || 'Выход', result: '' } as OutputNodeData;
        break;
      default:
        data = { label: customLabel || 'Новый узел' } as any;
    }

    const newNode: AppNode = {
      id: `node_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      type,
      position,
      data,
    };

    set({ nodes: [...get().nodes, newNode] });
  },
}));