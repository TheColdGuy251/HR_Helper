// app/app/editor/page.tsx
"use client";

import React, { useCallback, useRef } from "react";
import ReactFlow, {
  Background,
  Controls,
  ReactFlowProvider,
} from "reactflow";
import "reactflow/dist/style.css";
import Sidebar from "@/components/editor/sidebar"; // (не забудь переименовать файл с маленькой буквы)
import SettingsPanel from "@/components/editor/settingspanel";
import { useGraphStore } from "@/app/store/useGraphStore";
import { NodeType } from "@/app/types";

function FlowEditor() {
  const { 
    nodes, edges, onNodesChange, onEdgesChange, onConnect, 
    setSelectedNodeId, addNode 
  } = useGraphStore();
  
  const reactFlowWrapper = useRef<HTMLDivElement>(null);

  const onNodeClick = useCallback((_: React.MouseEvent, node: any) => {
    setSelectedNodeId(node.id);
  }, [setSelectedNodeId]);

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, [setSelectedNodeId]);

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

 const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const type = event.dataTransfer.getData("application/reactflow") as NodeType;
    const customLabel = event.dataTransfer.getData("application/reactflow-label");
    
    if (!type) return;

      const reactFlowBounds = reactFlowWrapper.current?.getBoundingClientRect();
      if (!reactFlowBounds) return;

      const position = {
        x: event.clientX - reactFlowBounds.left,
        y: event.clientY - reactFlowBounds.top,
      };

      
      addNode(type, position, customLabel); 
    },
    [addNode]
  );

  return (
    <div className="flex h-screen w-full">
      <Sidebar />
      <div className="flex-1 h-full relative" ref={reactFlowWrapper}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
      <SettingsPanel />
    </div>
  );
}

export default function EditorPage() {
  return (
    <ReactFlowProvider>
      <FlowEditor />
    </ReactFlowProvider>
  );
}