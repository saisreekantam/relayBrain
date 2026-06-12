'use client';

import React, { useEffect, useState } from 'react';
import styles from './ExecutionCenter.module.css';

const initialTasks = [
  { id: 1, text: 'Architecture designed', status: 'completed' },
  { id: 2, text: 'API endpoints generated', status: 'completed' },
  { id: 3, text: 'Unit tests passed (47/47)', status: 'completed' },
  { id: 4, text: 'CVE scan in progress...', status: 'active' },
  { id: 5, text: 'Deployment pending', status: 'pending' },
  { id: 6, text: 'Smoke tests pending', status: 'pending' },
];

export default function ExecutionCenter() {
  const [tasks, setTasks] = useState(initialTasks);
  const [progress, setProgress] = useState(72);

  // Fake progression timer
  useEffect(() => {
    const timer = setTimeout(() => {
      setTasks(prev => prev.map(t => {
        if (t.id === 4) return { ...t, text: 'CVE scan clear', status: 'completed' };
        if (t.id === 5) return { ...t, text: 'Deployment in progress...', status: 'active' };
        return t;
      }));
      setProgress(85);
    }, 4500);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className={`glass-panel ${styles.panel}`}>
      <div className="section-title">EXECUTION CENTER</div>
      
      <div className={styles.objectiveBlock}>
        <div className={styles.label}>CURRENT OBJECTIVE</div>
        <div className={styles.value}>Build Secure SaaS Landing Page</div>
      </div>

      <div className={styles.progressBlock}>
        <div className={styles.progressBar}>
          <div className={styles.progressFill} style={{ width: `${progress}%` }}></div>
        </div>
        <div className={`${styles.progressText} mono`}>{progress}%</div>
      </div>

      <div className={styles.statsGrid}>
        <div className={styles.stat}>
          <div className={styles.label}>CURRENT PHASE</div>
          <div className={styles.value}>Security Validation</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.label}>ACTIVE AGENT</div>
          <div className={styles.value}>Security Agent</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.label}>STARTED</div>
          <div className={styles.value}>2m 14s ago</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.label}>ETA</div>
          <div className={styles.value}>~4m</div>
        </div>
      </div>

      <div className={styles.tasksBlock}>
        <div className={styles.label}>SUB-TASKS</div>
        <div className={styles.taskList}>
          {tasks.map(task => (
            <div key={task.id} className={`${styles.task} ${styles[task.status]}`}>
              <span className={styles.taskIcon}>
                {task.status === 'completed' ? '✓' : task.status === 'active' ? '⟳' : '○'}
              </span>
              <span className={styles.taskText}>{task.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
