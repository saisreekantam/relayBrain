'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import styles from './WorkspaceRail.module.css';

interface Workspace {
  id: string;
  name: string;
  full: string;
  active: boolean;
}

const defaultWorkspaces: Workspace[] = [
  { id: 'gg', name: 'GG', full: 'GoalGuard', active: true },
  { id: 'os', name: 'OS', full: 'OrbitOS', active: false },
  { id: 'dt', name: 'DT', full: 'DataTool', active: false },
];

export default function WorkspaceRail() {
  const [isExpanded, setIsExpanded] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>(defaultWorkspaces);
  const router = useRouter();

  useEffect(() => {
    const saved = localStorage.getItem('mesh_workspaces');
    if (saved) {
      setWorkspaces(JSON.parse(saved));
    } else {
      localStorage.setItem('mesh_workspaces', JSON.stringify(defaultWorkspaces));
    }
  }, []);

  const selectWorkspace = (id: string) => {
    const updated = workspaces.map(ws => ({
      ...ws,
      active: ws.id === id
    }));
    setWorkspaces(updated);
    localStorage.setItem('mesh_workspaces', JSON.stringify(updated));
  };

  return (
    <nav 
      className={`${styles.rail} ${isExpanded ? styles.expanded : ''}`}
      onMouseEnter={() => setIsExpanded(true)}
      onMouseLeave={() => setIsExpanded(false)}
    >
      <div className={styles.topSection}>
        {isExpanded && <div className={styles.sectionTitle}>WORKSPACES</div>}
        {workspaces.map(ws => (
          <div 
            key={ws.id} 
            className={`${styles.itemWrapper} ${ws.active ? styles.activeWrapper : ''}`}
            onClick={() => selectWorkspace(ws.id)}
          >
            <div className={`${styles.workspaceIcon} ${ws.active ? styles.active : ''}`}>
              {ws.name}
            </div>
            {isExpanded && <span className={styles.itemText}>{ws.full}</span>}
          </div>
        ))}
        
        <div className={styles.itemWrapper} onClick={() => router.push('/onboarding')}>
          <div className={styles.addWorkspace}>+</div>
          {isExpanded && <span className={styles.itemText}>Add Workspace</span>}
        </div>

        <div className={styles.separator}></div>

        {isExpanded && <div className={styles.sectionTitle}>KNOWLEDGE</div>}
        <div className={styles.itemWrapper}>
          <div className={styles.allMemoriesIcon}>M</div>
          {isExpanded && <span className={styles.itemText}>All Memories</span>}
        </div>
      </div>

      <div className={styles.bottomSection}>
        <div className={styles.itemWrapper}>
          <div className={styles.actionIcon}>≡</div>
          {isExpanded && <span className={styles.itemText}>Settings</span>}
        </div>
        <div className={styles.itemWrapper}>
          <div className={styles.profileAvatar}>P</div>
          {isExpanded && <span className={styles.itemText}>Profile</span>}
        </div>
      </div>
    </nav>
  );
}
