'use client';

import React from 'react';
import styles from './AgentStatusPanel.module.css';

const agents = [
  { id: 'architect', name: 'Architect Agent', role: 'System Design', icon: '🧠', status: 'Idle', color: 'var(--accent-architect)' },
  { id: 'developer', name: 'Developer Agent', role: 'Implementation', icon: '⚙️', status: 'Idle', color: 'var(--accent-developer)' },
  { id: 'security', name: 'Security Agent', role: 'Vulnerability Scan', icon: '🛡️', status: 'Scanning', color: 'var(--accent-security)' },
  { id: 'deployment', name: 'Deployment Agent', role: 'Release', icon: '🚀', status: 'Deploying', color: 'var(--accent-deployment)' }
];

export default function AgentStatusPanel({ activeAgentId = 'deployment' }) {
  return (
    <div className={`glass-panel ${styles.panel}`}>
      <h2 className="section-title">Active Agents</h2>
      <div className={styles.grid}>
        {agents.map((agent) => {
          const isActive = agent.id === activeAgentId;
          return (
            <div 
              key={agent.id} 
              className={`${styles.agentCard} ${isActive ? styles.active : ''}`}
              style={{ '--agent-color': agent.color } as React.CSSProperties}
            >
              <div className={styles.iconWrapper}>
                <span className={styles.icon}>{agent.icon}</span>
                {isActive && <div className={styles.pulseRing}></div>}
              </div>
              <div className={styles.info}>
                <h3 className={styles.name}>{agent.name}</h3>
                <p className={styles.role}>{agent.role}</p>
              </div>
              <div className={styles.status}>
                <span className={`${styles.statusDot} ${isActive ? styles.statusDotActive : ''}`}></span>
                {isActive ? agent.status : 'Standby'}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
