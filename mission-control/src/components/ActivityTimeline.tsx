'use client';

import React, { useState, useEffect } from 'react';
import styles from './ActivityTimeline.module.css';

const initialActivities = [
  { id: 1, agent: 'Architect Agent', action: 'Proposed microservice split', time: '2 minutes ago', type: 'architect' },
  { id: 2, agent: 'Developer Agent', action: 'Generated 12 files', time: '90 seconds ago', type: 'developer' },
  { id: 3, agent: 'Security Agent', action: 'Detected outdated dependency', time: '45 seconds ago', type: 'security', alert: true },
];

const mockNewActivities = [
  { agent: 'Deployment Agent', action: 'Rolling out canary release', type: 'deployment' },
  { agent: 'Security Agent', action: 'Dependency updated and verified', type: 'security' },
  { agent: 'Developer Agent', action: 'Running integration tests', type: 'developer' }
];

export default function ActivityTimeline() {
  const [activities, setActivities] = useState(initialActivities);
  const [mockIndex, setMockIndex] = useState(0);

  useEffect(() => {
    // Simulate real-time activity for the hackathon feel
    if (mockIndex >= mockNewActivities.length) return;

    const timer = setTimeout(() => {
      const newActivity = {
        id: Date.now(),
        ...mockNewActivities[mockIndex],
        time: 'Just now'
      };
      
      setActivities(prev => [newActivity, ...prev]);
      setMockIndex(prev => prev + 1);
    }, 4000 + Math.random() * 3000); // Random interval between 4s and 7s

    return () => clearTimeout(timer);
  }, [mockIndex]);

  return (
    <div className={`glass-panel ${styles.panel}`}>
      <div className={styles.header}>
        <h2 className="section-title">Recent Activity</h2>
      </div>
      
      <div className={styles.feed}>
        {activities.map((activity) => (
          <div key={activity.id} className={`${styles.item} animate-fade-in`}>
            <div className={`${styles.indicator} ${styles[activity.type]}`}></div>
            <div className={styles.content}>
              <div className={styles.agentInfo}>
                <span className={styles.agentName}>{activity.agent}:</span>
                <span className={styles.time}>{activity.time}</span>
              </div>
              <div className={`${styles.action} ${activity.alert ? styles.alertText : ''}`}>
                {activity.action}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
