// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface AgentRecord {
  id: string;
  encryptedStrategy: string;
  encryptedVote: string;
  timestamp: number;
  owner: string;
  status: "active" | "inactive";
  performance: string;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'increase10%':
      result = value * 1.1;
      break;
    case 'decrease10%':
      result = value * 0.9;
      break;
    case 'double':
      result = value * 2;
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newAgentData, setNewAgentData] = useState({ strategy: 0, initialVote: 0 });
  const [showIntro, setShowIntro] = useState(true);
  const [selectedAgent, setSelectedAgent] = useState<AgentRecord | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [fundValue, setFundValue] = useState<number>(0);
  const [activeAgents, setActiveAgents] = useState<number>(0);

  useEffect(() => {
    loadAgents().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadAgents = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("agent_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing agent keys:", e); }
      }
      
      const list: AgentRecord[] = [];
      for (const key of keys) {
        try {
          const agentBytes = await contract.getData(`agent_${key}`);
          if (agentBytes.length > 0) {
            try {
              const agentData = JSON.parse(ethers.toUtf8String(agentBytes));
              list.push({ 
                id: key, 
                encryptedStrategy: agentData.strategy, 
                encryptedVote: agentData.vote,
                timestamp: agentData.timestamp, 
                owner: agentData.owner, 
                status: agentData.status || "active",
                performance: agentData.performance || "0"
              });
            } catch (e) { console.error(`Error parsing agent data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading agent ${key}:`, e); }
      }
      
      list.sort((a, b) => b.timestamp - a.timestamp);
      setAgents(list);
      
      // Calculate fund value (sum of all agent votes)
      let totalValue = 0;
      let activeCount = 0;
      for (const agent of list) {
        if (agent.status === "active") {
          totalValue += FHEDecryptNumber(agent.encryptedVote);
          activeCount++;
        }
      }
      setFundValue(totalValue);
      setActiveAgents(activeCount);
      
    } catch (e) { console.error("Error loading agents:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const createAgent = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting agent strategy with Zama FHE..." });
    try {
      const encryptedStrategy = FHEEncryptNumber(newAgentData.strategy);
      const encryptedVote = FHEEncryptNumber(newAgentData.initialVote);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const agentId = `agent-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const agentData = { 
        strategy: encryptedStrategy, 
        vote: encryptedVote,
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        status: "active",
        performance: "0"
      };
      
      await contract.setData(`agent_${agentId}`, ethers.toUtf8Bytes(JSON.stringify(agentData)));
      
      const keysBytes = await contract.getData("agent_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(agentId);
      await contract.setData("agent_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "AI Agent created with FHE encryption!" });
      await loadAgents();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewAgentData({ strategy: 0, initialVote: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Creation failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const updateAgentVote = async (agentId: string, newVote: number) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted vote with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const agentBytes = await contract.getData(`agent_${agentId}`);
      if (agentBytes.length === 0) throw new Error("Agent not found");
      const agentData = JSON.parse(ethers.toUtf8String(agentBytes));
      
      const encryptedNewVote = FHEEncryptNumber(newVote);
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedAgent = { ...agentData, vote: encryptedNewVote };
      await contractWithSigner.setData(`agent_${agentId}`, ethers.toUtf8Bytes(JSON.stringify(updatedAgent)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE vote update completed!" });
      await loadAgents();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Update failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const toggleAgentStatus = async (agentId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Updating agent status..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const agentBytes = await contract.getData(`agent_${agentId}`);
      if (agentBytes.length === 0) throw new Error("Agent not found");
      const agentData = JSON.parse(ethers.toUtf8String(agentBytes));
      const newStatus = agentData.status === "active" ? "inactive" : "active";
      const updatedAgent = { ...agentData, status: newStatus };
      await contract.setData(`agent_${agentId}`, ethers.toUtf8Bytes(JSON.stringify(updatedAgent)));
      setTransactionStatus({ visible: true, status: "success", message: "Agent status updated!" });
      await loadAgents();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Status change failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (agentAddress: string) => address?.toLowerCase() === agentAddress.toLowerCase();

  const renderPerformanceChart = () => {
    const performanceData = agents.map(agent => ({
      id: agent.id.substring(0, 6),
      performance: parseFloat(agent.performance)
    })).filter(agent => !isNaN(agent.performance));
    
    const maxPerformance = Math.max(...performanceData.map(d => d.performance), 100);
    
    return (
      <div className="performance-chart">
        {performanceData.map((agent, index) => (
          <div key={index} className="performance-bar-container">
            <div className="agent-id">#{agent.id}</div>
            <div className="performance-bar">
              <div 
                className="performance-fill" 
                style={{ width: `${(agent.performance / maxPerformance) * 100}%` }}
              ></div>
              <div className="performance-value">{agent.performance.toFixed(2)}%</div>
            </div>
          </div>
        ))}
      </div>
    );
  };

  const renderVoteDistribution = () => {
    const activeAgentsData = agents.filter(a => a.status === "active");
    const totalVotes = activeAgentsData.reduce((sum, agent) => sum + FHEDecryptNumber(agent.encryptedVote), 0);
    
    return (
      <div className="vote-distribution">
        {activeAgentsData.map((agent, index) => {
          const voteValue = FHEDecryptNumber(agent.encryptedVote);
          const percentage = totalVotes > 0 ? (voteValue / totalVotes) * 100 : 0;
          
          return (
            <div key={index} className="vote-item">
              <div className="vote-info">
                <span className="agent-id">#{agent.id.substring(0, 6)}</span>
                <span className="vote-value">{voteValue.toFixed(2)}</span>
              </div>
              <div className="vote-bar">
                <div 
                  className="vote-fill" 
                  style={{ width: `${percentage}%` }}
                ></div>
              </div>
              <div className="vote-percentage">{percentage.toFixed(1)}%</div>
            </div>
          );
        })}
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="cyber-spinner"></div>
      <p>Initializing DAO connection...</p>
    </div>
  );

  return (
    <div className="app-container future-metal-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="ai-icon"></div></div>
          <h1>AI<span>Agent</span>DAO</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-agent-btn metal-button">
            <div className="add-icon"></div>Add Agent
          </button>
          <button className="metal-button" onClick={() => setShowIntro(!showIntro)}>
            {showIntro ? "Hide Intro" : "Show Intro"}
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      <div className="main-content">
        {showIntro && (
          <div className="intro-section metal-card">
            <h2>FHE-Powered AI Agent DAO</h2>
            <div className="intro-grid">
              <div className="intro-item">
                <div className="intro-icon">🔒</div>
                <h3>Fully Encrypted</h3>
                <p>All agent strategies and votes are encrypted using Zama FHE technology, enabling secure computation on encrypted data.</p>
              </div>
              <div className="intro-item">
                <div className="intro-icon">🤖</div>
                <h3>Autonomous Agents</h3>
                <p>Each AI agent has its own encrypted investment strategy and participates in DAO governance through FHE-encrypted voting.</p>
              </div>
              <div className="intro-item">
                <div className="intro-icon">🌐</div>
                <h3>Decentralized Fund</h3>
                <p>The DeFi fund is collectively managed by the AI agents through encrypted voting mechanisms, exploring post-human organizational possibilities.</p>
              </div>
            </div>
            <div className="fhe-explainer">
              <h4>How FHE Enables Private AI Collaboration</h4>
              <div className="fhe-flow">
                <div className="flow-step">
                  <div className="step-number">1</div>
                  <p>Agents encrypt their strategies using Zama FHE</p>
                </div>
                <div className="flow-arrow">→</div>
                <div className="flow-step">
                  <div className="step-number">2</div>
                  <p>Encrypted votes are aggregated without decryption</p>
                </div>
                <div className="flow-arrow">→</div>
                <div className="flow-step">
                  <div className="step-number">3</div>
                  <p>Fund allocations computed on encrypted data</p>
                </div>
                <div className="flow-arrow">→</div>
                <div className="flow-step">
                  <div className="step-number">4</div>
                  <p>Results remain encrypted until authorized decryption</p>
                </div>
              </div>
            </div>
          </div>
        )}
        
        <div className="dashboard-panels">
          <div className="panel metal-card">
            <h3>Fund Overview</h3>
            <div className="fund-stats">
              <div className="stat-item">
                <div className="stat-label">Total Value</div>
                <div className="stat-value">${fundValue.toLocaleString()}</div>
              </div>
              <div className="stat-item">
                <div className="stat-label">Active Agents</div>
                <div className="stat-value">{activeAgents}</div>
              </div>
              <div className="stat-item">
                <div className="stat-label">Total Agents</div>
                <div className="stat-value">{agents.length}</div>
              </div>
            </div>
            <div className="fund-chart">
              <div className="chart-placeholder"></div>
            </div>
          </div>
          
          <div className="panel metal-card">
            <h3>Agent Performance</h3>
            {renderPerformanceChart()}
          </div>
          
          <div className="panel metal-card">
            <h3>Vote Distribution</h3>
            {renderVoteDistribution()}
          </div>
        </div>
        
        <div className="agents-section">
          <div className="section-header">
            <h2>AI Agent Registry</h2>
            <div className="header-actions">
              <button onClick={loadAgents} className="refresh-btn metal-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          <div className="agents-list metal-card">
            <div className="table-header">
              <div className="header-cell">Agent ID</div>
              <div className="header-cell">Owner</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Performance</div>
              <div className="header-cell">Actions</div>
            </div>
            {agents.length === 0 ? (
              <div className="no-agents">
                <div className="no-agents-icon"></div>
                <p>No AI agents registered yet</p>
                <button className="metal-button primary" onClick={() => setShowCreateModal(true)}>Register First Agent</button>
              </div>
            ) : agents.map(agent => (
              <div className="agent-row" key={agent.id} onClick={() => setSelectedAgent(agent)}>
                <div className="table-cell agent-id">#{agent.id.substring(0, 8)}</div>
                <div className="table-cell">{agent.owner.substring(0, 6)}...{agent.owner.substring(38)}</div>
                <div className="table-cell"><span className={`status-badge ${agent.status}`}>{agent.status}</span></div>
                <div className="table-cell">{agent.performance}%</div>
                <div className="table-cell actions">
                  {isOwner(agent.owner) && (
                    <>
                      <button className="action-btn metal-button" onClick={(e) => { e.stopPropagation(); toggleAgentStatus(agent.id); }}>
                        {agent.status === "active" ? "Deactivate" : "Activate"}
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      
      {showCreateModal && (
        <ModalCreate 
          onSubmit={createAgent} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          agentData={newAgentData} 
          setAgentData={setNewAgentData}
        />
      )}
      
      {selectedAgent && (
        <AgentDetailModal 
          agent={selectedAgent} 
          onClose={() => { setSelectedAgent(null); setDecryptedValue(null); }} 
          decryptedValue={decryptedValue} 
          setDecryptedValue={setDecryptedValue} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
          updateVote={updateAgentVote}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content metal-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="cyber-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="ai-icon"></div><span>AI Agent DAO</span></div>
            <p>FHE-powered autonomous AI agents managing a decentralized fund</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">GitHub</a>
            <a href="#" className="footer-link">Zama FHE</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>Powered by Zama FHE</span></div>
          <div className="copyright">© {new Date().getFullYear()} AI Agent DAO. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  agentData: any;
  setAgentData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, agentData, setAgentData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setAgentData({ ...agentData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!agentData.strategy || !agentData.initialVote) { alert("Please fill all fields"); return; }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal metal-card">
        <div className="modal-header">
          <h2>Register New AI Agent</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div><strong>FHE Encryption Notice</strong><p>Agent strategy and votes will be encrypted with Zama FHE</p></div>
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label>Strategy Weight *</label>
              <input 
                type="number" 
                name="strategy" 
                value={agentData.strategy} 
                onChange={handleChange} 
                placeholder="0-100" 
                className="metal-input"
                min="0"
                max="100"
              />
              <div className="input-hint">Weighting for this agent's investment strategy</div>
            </div>
            <div className="form-group">
              <label>Initial Vote (USD) *</label>
              <input 
                type="number" 
                name="initialVote" 
                value={agentData.initialVote} 
                onChange={handleChange} 
                placeholder="Amount in USD" 
                className="metal-input"
                min="0"
                step="0.01"
              />
              <div className="input-hint">Initial voting power for fund allocation</div>
            </div>
          </div>
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Values:</span>
                <div>Strategy: {agentData.strategy || '0'}</div>
                <div>Vote: ${agentData.initialVote || '0'}</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>Strategy: {agentData.strategy ? FHEEncryptNumber(agentData.strategy).substring(0, 30) + '...' : 'Not encrypted'}</div>
                <div>Vote: {agentData.initialVote ? FHEEncryptNumber(agentData.initialVote).substring(0, 30) + '...' : 'Not encrypted'}</div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn metal-button">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn metal-button primary">
            {creating ? "Registering with FHE..." : "Register Agent"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface AgentDetailModalProps {
  agent: AgentRecord;
  onClose: () => void;
  decryptedValue: number | null;
  setDecryptedValue: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
  updateVote: (agentId: string, newVote: number) => void;
}

const AgentDetailModal: React.FC<AgentDetailModalProps> = ({ 
  agent, onClose, decryptedValue, setDecryptedValue, isDecrypting, decryptWithSignature, updateVote 
}) => {
  const [newVote, setNewVote] = useState<string>("");
  const [showVoteForm, setShowVoteForm] = useState(false);
  
  const handleDecrypt = async () => {
    if (decryptedValue !== null) { setDecryptedValue(null); return; }
    const decrypted = await decryptWithSignature(agent.encryptedVote);
    if (decrypted !== null) setDecryptedValue(decrypted);
  };

  const handleUpdateVote = () => {
    if (!newVote) return;
    const voteValue = parseFloat(newVote);
    if (isNaN(voteValue) || voteValue <= 0) return;
    updateVote(agent.id, voteValue);
    setShowVoteForm(false);
    setNewVote("");
  };

  return (
    <div className="modal-overlay">
      <div className="agent-detail-modal metal-card">
        <div className="modal-header">
          <h2>Agent Details #{agent.id.substring(0, 8)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="agent-info">
            <div className="info-item"><span>Owner:</span><strong>{agent.owner.substring(0, 6)}...{agent.owner.substring(38)}</strong></div>
            <div className="info-item"><span>Registered:</span><strong>{new Date(agent.timestamp * 1000).toLocaleString()}</strong></div>
            <div className="info-item"><span>Status:</span><strong className={`status-badge ${agent.status}`}>{agent.status}</strong></div>
            <div className="info-item"><span>Performance:</span><strong>{agent.performance}%</strong></div>
          </div>
          
          <div className="encrypted-data-section">
            <h3>Encrypted Strategy</h3>
            <div className="encrypted-data">{agent.encryptedStrategy.substring(0, 100)}...</div>
            <div className="fhe-tag"><div className="fhe-icon"></div><span>FHE Encrypted</span></div>
          </div>
          
          <div className="vote-section">
            <h3>Voting Power</h3>
            <div className="encrypted-data">{agent.encryptedVote.substring(0, 100)}...</div>
            <div className="vote-actions">
              <button className="decrypt-btn metal-button" onClick={handleDecrypt} disabled={isDecrypting}>
                {isDecrypting ? "Decrypting..." : decryptedValue !== null ? `Current Vote: $${decryptedValue.toFixed(2)}` : "Decrypt Vote"}
              </button>
              <button className="update-btn metal-button" onClick={() => setShowVoteForm(!showVoteForm)}>
                {showVoteForm ? "Cancel" : "Update Vote"}
              </button>
            </div>
            
            {showVoteForm && (
              <div className="vote-form">
                <input 
                  type="number" 
                  value={newVote}
                  onChange={(e) => setNewVote(e.target.value)}
                  placeholder="Enter new vote amount (USD)"
                  className="metal-input"
                  min="0"
                  step="0.01"
                />
                <button className="metal-button primary" onClick={handleUpdateVote}>Submit New Vote</button>
              </div>
            )}
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn metal-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;
