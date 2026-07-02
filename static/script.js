let currentPath = null;           // 当前展示的文件夹路径
let myChart = null;
let treeRoot = null;             // 左侧树根节点引用

// 工具函数
function formatSize(bytes) {
    if (bytes >= 1024**4) return (bytes/1024**4).toFixed(2)+' TB';
    if (bytes >= 1024**3) return (bytes/1024**3).toFixed(2)+' GB';
    if (bytes >= 1024**2) return (bytes/1024**2).toFixed(2)+' MB';
    if (bytes >= 1024) return (bytes/1024).toFixed(2)+' KB';
    return bytes + ' B';
}

// ECharts 初始化
function initChart() {
    myChart = echarts.init(document.getElementById('chart-container'));
    myChart.on('click', function(params) {
        if (params.data && params.data.type === 'dir') {
            // 下钻到文件夹
            loadDirectory(params.data.path);
            // 左侧树同步高亮
            highlightTreeNode(params.data.path);
        } else {
            // 显示文件/聚合项详情
            showDetailModal(params.data);
        }
    });
}

// 更新饼图
function updateChart(data) {
    if (!myChart) return;
    const option = {
        tooltip: {
            trigger: 'item',
            formatter: function(params) {
                return `${params.name}<br/>大小: ${params.data.size_str}`;
            }
        },
        series: [{
            type: 'pie',
            radius: ['25%', '65%'],
            center: ['50%', '50%'],
            data: data.map(item => ({
                value: item.size,
                name: item.name,
                ...item
            })),
            label: {
                formatter: '{b}: {d}%'
            },
            emphasis: {
                itemStyle: {
                    shadowBlur: 10,
                    shadowOffsetX: 0,
                    shadowColor: 'rgba(0, 0, 0, 0.5)'
                }
            }
        }]
    };
    myChart.setOption(option, true);
}

// 加载指定文件夹内容
async function loadDirectory(path) {
    currentPath = path;
    document.getElementById('placeholder').classList.add('hidden');
    try {
        const resp = await fetch(`/api/children?path=${encodeURIComponent(path)}`);
        if (!resp.ok) throw new Error('Path not found');
        const data = await resp.json();
        updateChart(data);
    } catch (e) {
        alert('加载目录失败: ' + e.message);
    }
}

// 显示详细信息弹窗
function showDetailModal(item) {
    let content = `<h3>${item.name}</h3>`;
    content += `<p>类型: ${item.type}</p>`;
    content += `<p>大小: ${item.size_str} (${item.size} 字节)</p>`;
    if (item.path) {
        content += `<p>路径: ${item.path}</p>`;
    }
    if (item.count) {
        content += `<p>包含 ${item.count} 项</p>`;
    }
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-content">
            <span class="modal-close">&times;</span>
            ${content}
        </div>`;
    modal.querySelector('.modal-close').onclick = () => modal.remove();
    modal.addEventListener('click', (e) => { if(e.target === modal) modal.remove(); });
    document.body.appendChild(modal);
}

// 左侧树构建
function buildTree() {
    const treeContainer = document.getElementById('tree');
    treeContainer.innerHTML = '';
    const ul = document.createElement('ul');
    const rootLi = createTreeNode('我的电脑', null, true, true);
    ul.appendChild(rootLi);
    treeContainer.appendChild(ul);
    treeRoot = rootLi;
    // 加载盘符列表
    loadDrives();
}

function createTreeNode(name, path, isDir = true, expanded = false) {
    const li = document.createElement('li');
    const nodeDiv = document.createElement('div');
    nodeDiv.className = 'node';
    if (path) nodeDiv.dataset.path = path;

    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.innerHTML = '&#9654;';
    if (expanded) arrow.classList.add('expanded');
    arrow.style.visibility = isDir ? 'visible' : 'hidden';

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.innerHTML = isDir ? '📁' : '📄';

    const label = document.createElement('span');
    label.textContent = name;

    nodeDiv.appendChild(arrow);
    nodeDiv.appendChild(icon);
    nodeDiv.appendChild(label);

    li.appendChild(nodeDiv);

    const childUl = document.createElement('ul');
    if (expanded) childUl.style.display = 'block';
    else childUl.style.display = 'none';
    li.appendChild(childUl);

    // 点击文本：加载内容
    label.addEventListener('click', (e) => {
        e.stopPropagation();
        if (onClick) {
            onClick(path);      // 如果有自定义回调，优先使用
        } else if (isDir && path) {
            loadDirectory(path);
            highlightTreeNode(path);
        }
    });

    // 点击箭头：展开/折叠并懒加载
    arrow.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!isDir || !path) return;
        const isExpanded = childUl.style.display === 'block';
        if (isExpanded) {
            childUl.style.display = 'none';
            arrow.classList.remove('expanded');
        } else {
            // 检查是否已加载子节点
            if (childUl.children.length === 0) {
                await loadSubdirs(path, childUl);
            }
            childUl.style.display = 'block';
            arrow.classList.add('expanded');
        }
    });

    return li;
}

async function loadSubdirs(path, parentUl) {
    try {
        const resp = await fetch(`/api/subdirs?path=${encodeURIComponent(path)}`);
        const dirs = await resp.json();
        dirs.forEach(d => {
            const li = createTreeNode(d.name, d.path, true, false);
            // 如果has_children为false，则箭头不可见，但保留结构
            parentUl.appendChild(li);
        });
    } catch (e) {
        console.error(e);
    }
}

async function loadDrives() {
    const resp = await fetch('/api/drives');
    const drives = await resp.json();
    const rootUl = treeRoot.querySelector('ul');
    rootUl.innerHTML = '';
    drives.forEach(d => {
        const path = d.label;
        const name = `${path} (${d.total_str})`;
        const li = createTreeNode(name, path, true, false, async (p) => {
            await startScanAndLoad(p);
        });
        rootUl.appendChild(li);
    });
}

async function startScanAndLoad(rootPath) {
    // 启动扫描
    showProgressOverlay(true);
    const resp = await fetch('/api/scan', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path: rootPath})
    });
    const { task_id } = await resp.json();
    // 轮询进度
    await pollProgress(task_id);
    showProgressOverlay(false);
    // 扫描完成，加载根目录内容
    loadDirectory(rootPath);
    // 展开左侧盘符节点
    expandDriveNode(rootPath);
}

async function pollProgress(taskId) {
    const textEl = document.getElementById('progress-text');
    const fillEl = document.getElementById('progress-fill');
    while (true) {
        const resp = await fetch(`/api/progress/${taskId}`);
        const data = await resp.json();
        fillEl.style.width = data.progress + '%';
        textEl.textContent = data.current + ` (${data.progress}%)`;
        if (data.done) break;
        await new Promise(r => setTimeout(r, 300));
    }
}

function showProgressOverlay(show) {
    document.getElementById('progress-overlay').classList.toggle('hidden', !show);
}

function expandDriveNode(rootPath) {
    // 在树中找到该路径节点并展开，加载第一层子目录
    const nodeDiv = document.querySelector(`.node[data-path="${rootPath.replace(/\\/g, '\\\\')}"]`);
    if (!nodeDiv) return;
    const li = nodeDiv.parentElement;
    const childUl = li.querySelector('ul');
    const arrow = nodeDiv.querySelector('.arrow');
    if (!childUl || !arrow) return;
    if (childUl.children.length === 0) {
        // 加载子目录
        loadSubdirs(rootPath, childUl).then(() => {
            childUl.style.display = 'block';
            arrow.classList.add('expanded');
        });
    } else {
        childUl.style.display = 'block';
        arrow.classList.add('expanded');
    }
}

function highlightTreeNode(path) {
    // 移除所有active
    document.querySelectorAll('.node.active').forEach(n => n.classList.remove('active'));
    if (!path) return;
    const normalized = path.replace(/\\/g, '\\\\');
    const nodeDiv = document.querySelector(`.node[data-path="${normalized}"]`);
    if (nodeDiv) {
        nodeDiv.classList.add('active');
    }
}

// 顶部按钮
document.getElementById('btn-root').addEventListener('click', () => {
    currentPath = null;
    document.getElementById('placeholder').classList.remove('hidden');
    if (myChart) myChart.clear();
    highlightTreeNode(null);
    // 树保持盘符列表
});

document.getElementById('btn-up').addEventListener('click', () => {
    if (!currentPath) return;
    // 获取父路径
    const parts = currentPath.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length <= 1) {
        // 已经是盘符根，回到我的电脑
        document.getElementById('btn-root').click();
        return;
    }
    parts.pop();
    const parentPath = parts.join('/');
    // 确保盘符带斜杠
    const finalPath = parentPath.length === 1 ? parentPath + ':/' : parentPath;
    loadDirectory(finalPath);
    highlightTreeNode(finalPath);
});

// 启动
window.onload = function() {
    initChart();
    buildTree();
    document.getElementById('placeholder').classList.remove('hidden');
};