import { create } from 'zustand';
import { applyNodeChanges, applyEdgeChanges, addEdge, NodeChange, EdgeChange, Connection } from 'reactflow';
import { AppNode, AppEdge } from '@/app/types';

interface GraphState {
  nodes: AppNode[];
  edges: AppEdge[];
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
}

export const useGraphStore = create<GraphState>((set, get) => ({
  nodes: [],
  edges: [],
  onNodesChange: (changes) => {
    set({ nodes: applyNodeChanges(changes, get().nodes) as AppNode[] });
  },
  onEdgesChange: (changes) => {
    set({ edges: applyEdgeChanges(changes, get().edges) as AppEdge[] });
  },
  onConnect: (connection) => {
    set({ edges: addEdge(connection, get().edges) as AppEdge[] });
  },
}));