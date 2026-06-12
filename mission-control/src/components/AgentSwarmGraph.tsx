'use client';

import React, { useEffect, useState } from 'react';
import styles from './AgentSwarmGraph.module.css';

const nodes = [
  { id: 'ceo', label: 'CEO', x: 50, y: 10 },
  { id: 'arch', label: 'Architect', x: 20, y: 40 },
  { id: 'sec', label: 'Security', x: 80, y: 40 },
  { id: 'dev', label: 'Backend', x: 20, y: 80 },
  { id: 'qa', label: 'QA', x: 50, y: 70 },
  { id: 'deploy', label: 'Deployment', x: 80, y: 80 },
];

const edges = [
  { from: 'ceo', to: 'arch' },
  { from: 'ceo', to: 'sec' },
  { from: 'arch', to: 'dev' },
  { from: 'dev', to: 'qa' },
  { from: 'qa', to: 'sec' },
  { from: 'sec', to: 'deploy' },
  { from: 'qa', to: 'deploy' },
];

export default function AgentSwarmGraph() {
  const [activeNode, setActiveNode] = useState('arch');
  const [thinkingNode, setThinkingNode] = useState('dev');

  // Gimmick timer to cycle states
  useEffect(() => {
    const cycle = ['ceo', 'arch', 'dev', 'qa', 'sec', 'deploy'];
    let i = 1;
    const interval = setInterval(() => {
      setActiveNode(cycle[i]);
      setThinkingNode(cycle[(i + 1) % cycle.length]);
      i = (i + 1) % cycle.length;
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className={`glass-panel ${styles.panel}`}>
      <div className="section-title">AGENT SWARM GRAPH</div>
      <div className={styles.graphContainer}>
        <svg className={styles.edgesSvg}>
          {edges.map((edge, i) => {
            const fromNode = nodes.find(n => n.id === edge.from);
            const toNode = nodes.find(n => n.id === edge.to);
            if (!fromNode || !toNode) return null;
            return (
              <line 
                key={i}
                x1={`${fromNode.x}%`} 
                y1={`${fromNode.y}%`} 
                x2={`${toNode.x}%`} 
                y2={`${toNode.y}%`} 
                className={styles.edgeLine}
              />
            );
          })}
        </svg>

        {nodes.map(node => {
          let stateClass = styles.idle;
          if (node.id === activeNode) stateClass = styles.active;
          if (node.id === thinkingNode) stateClass = styles.thinking;

          return (
            <div 
              key={node.id} 
              className={`${styles.node} ${stateClass}`}
              style={{ left: `${node.x}%`, top: `${node.y}%` }}
            >
              <div className={styles.nodeCore}></div>
              <span className={styles.nodeLabel}>{node.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
