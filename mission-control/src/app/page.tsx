import React from 'react';
import GlobalHeader from '@/components/GlobalHeader';
import Sidebar from '@/components/Sidebar';
import GroupChat from '@/components/GroupChat';
import AgentSwarmGraph from '@/components/AgentSwarmGraph';
import ExecutionCenter from '@/components/ExecutionCenter';
import ContextMemory from '@/components/ContextMemory';
import TaskQueue from '@/components/TaskQueue';
import SecurityOps from '@/components/SecurityOps';
import InfrastructureBar from '@/components/InfrastructureBar';
import styles from './page.module.css';

export default function Home() {
  return (
    <div className={styles.layout}>
      <GlobalHeader />
      
      <main className={styles.mainArea}>
        <Sidebar />
        
        <div className={styles.chatArea}>
          <GroupChat />
        </div>

        <div className={`${styles.controlRoomArea} custom-scrollbar`}>
          <div className={styles.stackPanel}>
            <AgentSwarmGraph />
          </div>
          <div className={styles.stackPanel}>
            <ExecutionCenter />
          </div>
          <div className={styles.stackPanel}>
            <SecurityOps />
          </div>
          <div className={styles.stackPanel}>
            <TaskQueue />
          </div>
          <div className={styles.stackPanel}>
            <ContextMemory />
          </div>
        </div>
      </main>

      <InfrastructureBar />
    </div>
  );
}
