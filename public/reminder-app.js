/**
 * 育儿提醒应用主逻辑
 */
class ReminderApp {
    constructor() {
        this.children = [];
        this.reminders = [];
        this.categories = [];
        this.records = [];
        this.currentView = 'timeline';
        this.selectedChildId = 'all';
        this.currentDate = new Date();

        this.init();
    }

    async init() {
        // 注册 Service Worker
        this.registerServiceWorker();

        // 检查认证状态
        const authStatus = await this.checkAuth();
        if (!authStatus.authenticated) {
            window.location.href = '/login.html';
            return;
        }

        // 隐藏加载状态，显示主内容
        document.getElementById('authLoading').style.display = 'none';
        document.getElementById('mainContent').style.display = 'block';

        // 初始化UI元素
        this.initializeElements();

        // 加载初始数据
        await this.loadInitialData();

        // 设置事件监听器
        this.setupEventListeners();

        // 初始化通知权限
        this.requestNotificationPermission();

        // 启动定时检查
        this.startReminderCheck();

        // 显示今日日期
        this.updateTodayDate();
    }

    async registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            try {
                const registration = await navigator.serviceWorker.register('/service-worker.js');
                console.log('Service Worker registered:', registration);

                // 请求后台同步权限
                if ('sync' in registration) {
                    await registration.sync.register('sync-reminders');
                }

                // 请求定期后台同步权限
                if ('periodicSync' in registration) {
                    const status = await navigator.permissions.query({
                        name: 'periodic-background-sync',
                    });
                    if (status.state === 'granted') {
                        await registration.periodicSync.register('check-reminders', {
                            minInterval: 60 * 60 * 1000 // 每小时检查一次
                        });
                    }
                }
            } catch (error) {
                console.error('Service Worker registration failed:', error);
            }
        }
    }

    initializeElements() {
        // 选择器和按钮
        this.childSelector = document.getElementById('childSelector');
        this.addChildBtn = document.getElementById('addChildBtn');
        this.addReminderBtn = document.getElementById('addReminderBtn');
        this.logoutBtn = document.getElementById('logoutBtn');
        this.notificationBtn = document.getElementById('notificationBtn');

        // 视图切换
        this.viewToggle = document.getElementById('viewToggle');
        this.viewButtons = this.viewToggle.querySelectorAll('.view-btn');

        // 视图容器
        this.timelineView = document.getElementById('timelineView');
        this.calendarView = document.getElementById('calendarView');
        this.statsView = document.getElementById('statsView');

        // 弹窗
        this.childModal = document.getElementById('childModal');
        this.reminderModal = document.getElementById('reminderModal');

        // 表单
        this.childForm = document.getElementById('childForm');
        this.reminderForm = document.getElementById('reminderForm');

        // 统计元素
        this.totalTasks = document.getElementById('totalTasks');
        this.completedTasks = document.getElementById('completedTasks');
        this.pendingTasks = document.getElementById('pendingTasks');
        this.completionRate = document.getElementById('completionRate');

        // Toast容器
        this.toastContainer = document.getElementById('toastContainer');
    }

    setupEventListeners() {
        // 孩子选择器
        this.childSelector.addEventListener('change', (e) => {
            this.selectedChildId = e.target.value;
            this.refreshCurrentView();
        });

        // 添加孩子按钮
        this.addChildBtn.addEventListener('click', () => {
            this.showChildModal();
        });

        // 添加提醒按钮
        this.addReminderBtn.addEventListener('click', () => {
            this.showReminderModal();
        });

        // 视图切换
        this.viewButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const view = btn.dataset.view;
                this.switchView(view);
            });
        });

        // 退出登录
        this.logoutBtn.addEventListener('click', () => {
            this.logout();
        });

        // 通知设置
        this.notificationBtn.addEventListener('click', () => {
            this.toggleNotifications();
        });

        // 弹窗关闭按钮
        document.getElementById('closeChildModal').addEventListener('click', () => {
            this.hideChildModal();
        });

        document.getElementById('closeReminderModal').addEventListener('click', () => {
            this.hideReminderModal();
        });

        document.getElementById('cancelChild').addEventListener('click', () => {
            this.hideChildModal();
        });

        document.getElementById('cancelReminder').addEventListener('click', () => {
            this.hideReminderModal();
        });

        // 表单提交
        this.childForm.addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveChild();
        });

        this.reminderForm.addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveReminder();
        });

        // 日历导航
        document.getElementById('prevMonth').addEventListener('click', () => {
            this.navigateMonth(-1);
        });

        document.getElementById('nextMonth').addEventListener('click', () => {
            this.navigateMonth(1);
        });

        // 统计刷新
        document.getElementById('refreshStats').addEventListener('click', () => {
            this.refreshStatistics();
        });
    }

    async checkAuth() {
        try {
            const response = await fetch('/api/auth/status');
            return await response.json();
        } catch (error) {
            console.error('Auth check failed:', error);
            return { authenticated: false };
        }
    }

    async loadInitialData() {
        try {
            // 并行加载所有数据
            const [categoriesRes, childrenRes, remindersRes, recordsRes] = await Promise.all([
                fetch('/api/categories'),
                fetch('/api/children'),
                fetch('/api/reminders'),
                fetch('/api/records?date=' + this.currentDate.toISOString().split('T')[0])
            ]);

            const categoriesData = await categoriesRes.json();
            const childrenData = await childrenRes.json();
            const remindersData = await remindersRes.json();
            const recordsData = await recordsRes.json();

            this.categories = categoriesData.categories || [];
            this.children = childrenData.children || [];
            this.reminders = remindersData.reminders || [];
            this.records = recordsData.records || [];

            // 更新UI
            this.updateChildSelector();
            this.updateCategorySelector();
            this.refreshCurrentView();
            this.updateTodayOverview();

        } catch (error) {
            console.error('Failed to load initial data:', error);
            this.showToast('加载数据失败，请刷新页面重试', 'error');
        }
    }

    updateChildSelector() {
        this.childSelector.innerHTML = '<option value="all">所有孩子</option>';
        this.children.forEach(child => {
            const option = document.createElement('option');
            option.value = child.id;
            option.textContent = `${child.avatar} ${child.name}`;
            this.childSelector.appendChild(option);
        });

        // 更新提醒表单中的孩子选择器
        const reminderChild = document.getElementById('reminderChild');
        reminderChild.innerHTML = '<option value="">请选择</option>';
        this.children.forEach(child => {
            const option = document.createElement('option');
            option.value = child.id;
            option.textContent = `${child.avatar} ${child.name}`;
            reminderChild.appendChild(option);
        });
    }

    updateCategorySelector() {
        const reminderCategory = document.getElementById('reminderCategory');
        reminderCategory.innerHTML = '<option value="">请选择</option>';
        this.categories.forEach(category => {
            const option = document.createElement('option');
            option.value = category.id;
            option.textContent = `${category.icon} ${category.name}`;
            reminderCategory.appendChild(option);
        });
    }

    updateTodayDate() {
        const todayDate = document.getElementById('todayDate');
        const options = { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' };
        todayDate.textContent = this.currentDate.toLocaleDateString('zh-CN', options);
    }

    updateTodayOverview() {
        const todayReminders = this.getTodayReminders();
        const completedCount = this.records.filter(r => r.status === 'completed').length;
        const pendingCount = todayReminders.length - completedCount;
        const rate = todayReminders.length > 0 ?
            Math.round((completedCount / todayReminders.length) * 100) : 0;

        this.totalTasks.textContent = todayReminders.length;
        this.completedTasks.textContent = completedCount;
        this.pendingTasks.textContent = pendingCount;
        this.completionRate.textContent = rate + '%';
    }

    getTodayReminders() {
        const today = this.currentDate.toISOString().split('T')[0];
        return this.reminders.filter(reminder => {
            if (!reminder.enabled) return false;

            if (this.selectedChildId !== 'all' && reminder.childId !== this.selectedChildId) {
                return false;
            }

            if (reminder.reminderType === 'once') {
                const reminderDate = new Date(reminder.reminderTime).toISOString().split('T')[0];
                return reminderDate === today;
            } else if (reminder.reminderType === 'daily') {
                return true;
            } else if (reminder.reminderType === 'weekly') {
                const reminderDay = new Date(reminder.reminderTime).getDay();
                const todayDay = this.currentDate.getDay();
                return reminderDay === todayDay;
            } else if (reminder.reminderType === 'monthly') {
                const reminderDate = new Date(reminder.reminderTime).getDate();
                const todayDate = this.currentDate.getDate();
                return reminderDate === todayDate;
            }
            return false;
        });
    }

    switchView(view) {
        // 更新按钮状态
        this.viewButtons.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === view);
        });

        // 更新视图显示
        document.querySelectorAll('.view-content').forEach(content => {
            content.classList.remove('active');
        });

        switch (view) {
            case 'timeline':
                this.timelineView.classList.add('active');
                this.renderTimeline();
                break;
            case 'calendar':
                this.calendarView.classList.add('active');
                this.renderCalendar();
                break;
            case 'stats':
                this.statsView.classList.add('active');
                this.renderStatistics();
                break;
        }

        this.currentView = view;
    }

    refreshCurrentView() {
        switch (this.currentView) {
            case 'timeline':
                this.renderTimeline();
                break;
            case 'calendar':
                this.renderCalendar();
                break;
            case 'stats':
                this.renderStatistics();
                break;
        }
        this.updateTodayOverview();
    }

    renderTimeline() {
        const container = document.getElementById('timelineContainer');
        const todayReminders = this.getTodayReminders();

        if (todayReminders.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"></circle>
                        <path d="M8 14s1.5 2 4 2 4-2 4-2"></path>
                        <line x1="9" y1="9" x2="9.01" y2="9"></line>
                        <line x1="15" y1="9" x2="15.01" y2="9"></line>
                    </svg>
                    <h3>今日暂无提醒</h3>
                    <p>点击"添加提醒"按钮创建新的提醒任务</p>
                </div>
            `;
            return;
        }

        // 按时间排序
        todayReminders.sort((a, b) => {
            const timeA = new Date(a.reminderTime).getTime();
            const timeB = new Date(b.reminderTime).getTime();
            return timeA - timeB;
        });

        container.innerHTML = todayReminders.map(reminder => {
            const child = this.children.find(c => c.id === reminder.childId);
            const category = this.categories.find(c => c.id === reminder.category);
            const record = this.records.find(r => r.reminderId === reminder.id);
            const isCompleted = record && record.status === 'completed';
            const time = new Date(reminder.reminderTime).toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit'
            });

            return `
                <div class="timeline-item ${isCompleted ? 'completed' : ''}">
                    <div class="timeline-time">${time}</div>
                    <div class="timeline-content">
                        <div class="timeline-info">
                            <div class="timeline-title">${reminder.title}</div>
                            <div class="timeline-meta">
                                ${category ? `
                                    <span class="timeline-category">
                                        ${category.icon} ${category.name}
                                    </span>
                                ` : ''}
                                ${child ? `
                                    <span class="timeline-child">
                                        ${child.avatar} ${child.name}
                                    </span>
                                ` : ''}
                            </div>
                        </div>
                        <div class="timeline-actions">
                            ${!isCompleted ? `
                                <button class="action-btn complete" onclick="app.completeReminder('${reminder.id}')">完成</button>
                                <button class="action-btn skip" onclick="app.skipReminder('${reminder.id}')">跳过</button>
                                <button class="action-btn delay" onclick="app.delayReminder('${reminder.id}')">延后</button>
                            ` : `
                                <span class="action-btn complete">✓ 已完成</span>
                            `}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    renderCalendar() {
        const container = document.getElementById('calendarGrid');
        const currentMonth = document.getElementById('currentMonth');

        // 更新月份显示
        const monthNames = ['一月', '二月', '三月', '四月', '五月', '六月',
                           '七月', '八月', '九月', '十月', '十一月', '十二月'];
        currentMonth.textContent = `${this.currentDate.getFullYear()}年 ${monthNames[this.currentDate.getMonth()]}`;

        // 获取月份第一天和最后一天
        const firstDay = new Date(this.currentDate.getFullYear(), this.currentDate.getMonth(), 1);
        const lastDay = new Date(this.currentDate.getFullYear(), this.currentDate.getMonth() + 1, 0);
        const startDay = firstDay.getDay() || 7; // 周日为7

        // 创建日历网格
        let html = '';

        // 星期标题
        const weekDays = ['一', '二', '三', '四', '五', '六', '日'];
        weekDays.forEach(day => {
            html += `<div class="calendar-header-day">${day}</div>`;
        });

        // 空白天数
        for (let i = 1; i < startDay; i++) {
            html += '<div class="calendar-day empty"></div>';
        }

        // 日历天数
        const today = new Date();
        for (let day = 1; day <= lastDay.getDate(); day++) {
            const date = new Date(this.currentDate.getFullYear(), this.currentDate.getMonth(), day);
            const isToday = date.toDateString() === today.toDateString();
            const dateStr = date.toISOString().split('T')[0];

            // 获取该日期的提醒数量
            const dayReminders = this.getRemindersForDate(date);

            html += `
                <div class="calendar-day ${isToday ? 'today' : ''}" data-date="${dateStr}">
                    <div class="calendar-day-number">${day}</div>
                    ${dayReminders.length > 0 ? `
                        <div class="calendar-day-tasks">
                            ${dayReminders.slice(0, 3).map(() => '<span class="task-indicator"></span>').join('')}
                            ${dayReminders.length > 3 ? `<span>+${dayReminders.length - 3}</span>` : ''}
                        </div>
                    ` : ''}
                </div>
            `;
        }

        container.innerHTML = html;
    }

    getRemindersForDate(date) {
        const dateStr = date.toISOString().split('T')[0];
        return this.reminders.filter(reminder => {
            if (!reminder.enabled) return false;

            if (this.selectedChildId !== 'all' && reminder.childId !== this.selectedChildId) {
                return false;
            }

            if (reminder.reminderType === 'once') {
                const reminderDate = new Date(reminder.reminderTime).toISOString().split('T')[0];
                return reminderDate === dateStr;
            } else if (reminder.reminderType === 'daily') {
                return true;
            } else if (reminder.reminderType === 'weekly') {
                const reminderDay = new Date(reminder.reminderTime).getDay();
                const targetDay = date.getDay();
                return reminderDay === targetDay;
            } else if (reminder.reminderType === 'monthly') {
                const reminderDate = new Date(reminder.reminderTime).getDate();
                const targetDate = date.getDate();
                return reminderDate === targetDate;
            }
            return false;
        });
    }

    async renderStatistics() {
        const container = document.getElementById('statsContainer');

        // 获取日期范围
        const startDate = document.getElementById('startDate').value ||
            new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const endDate = document.getElementById('endDate').value ||
            new Date().toISOString().split('T')[0];

        try {
            const response = await fetch(`/api/statistics?childId=${this.selectedChildId}&startDate=${startDate}&endDate=${endDate}`);
            const data = await response.json();
            const stats = data.statistics;

            container.innerHTML = `
                <div class="stat-card">
                    <h4>整体完成情况</h4>
                    <div class="chart-container">
                        <div class="chart-bar" style="height: ${stats.completedTasks / stats.totalTasks * 100}%; background: var(--success-color)">
                            <span class="chart-label">已完成<br>${stats.completedTasks}</span>
                        </div>
                        <div class="chart-bar" style="height: ${stats.skippedTasks / stats.totalTasks * 100}%; background: var(--warning-color)">
                            <span class="chart-label">已跳过<br>${stats.skippedTasks}</span>
                        </div>
                        <div class="chart-bar" style="height: ${stats.pendingTasks / stats.totalTasks * 100}%; background: var(--text-secondary)">
                            <span class="chart-label">待完成<br>${stats.pendingTasks}</span>
                        </div>
                    </div>
                </div>

                <div class="stat-card">
                    <h4>分类统计</h4>
                    <div class="category-stats">
                        ${Object.entries(stats.categoryStats).map(([categoryId, catStats]) => {
                            const category = this.categories.find(c => c.id === categoryId);
                            if (!category) return '';

                            const rate = catStats.total > 0 ?
                                Math.round((catStats.completed / catStats.total) * 100) : 0;

                            return `
                                <div class="category-stat-item">
                                    <div class="category-stat-header">
                                        <span>${category.icon} ${category.name}</span>
                                        <span>${rate}%</span>
                                    </div>
                                    <div class="category-stat-bar">
                                        <div class="category-stat-fill" style="width: ${rate}%; background: ${category.color}"></div>
                                    </div>
                                    <div class="category-stat-meta">
                                        ${catStats.completed}/${catStats.total} 已完成
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `;
        } catch (error) {
            console.error('Failed to load statistics:', error);
            container.innerHTML = '<div class="empty-state">加载统计数据失败</div>';
        }
    }

    navigateMonth(direction) {
        this.currentDate.setMonth(this.currentDate.getMonth() + direction);
        this.renderCalendar();
    }

    async refreshStatistics() {
        await this.renderStatistics();
        this.showToast('统计数据已更新', 'success');
    }

    // 弹窗管理
    showChildModal() {
        this.childModal.style.display = 'flex';
        this.childForm.reset();
    }

    hideChildModal() {
        this.childModal.style.display = 'none';
    }

    showReminderModal() {
        this.reminderModal.style.display = 'flex';
        this.reminderForm.reset();

        // 设置默认时间为当前时间
        const now = new Date();
        const datetime = now.toISOString().slice(0, 16);
        document.getElementById('reminderTime').value = datetime;
    }

    hideReminderModal() {
        this.reminderModal.style.display = 'none';
    }

    // 数据操作
    async saveChild() {
        const formData = new FormData(this.childForm);
        const childData = {
            name: formData.get('childName'),
            age: formData.get('childAge'),
            birthday: formData.get('childBirthday'),
            avatar: formData.get('avatar')
        };

        try {
            const response = await fetch('/api/children', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(childData)
            });

            if (response.ok) {
                const result = await response.json();
                this.children.push(result.child);
                this.updateChildSelector();
                this.hideChildModal();
                this.showToast('孩子信息已添加', 'success');
            } else {
                throw new Error('Failed to save child');
            }
        } catch (error) {
            console.error('Error saving child:', error);
            this.showToast('保存失败，请重试', 'error');
        }
    }

    async saveReminder() {
        const formData = new FormData(this.reminderForm);
        const reminderData = {
            childId: formData.get('reminderChild'),
            title: formData.get('reminderTitle'),
            description: formData.get('reminderDesc'),
            category: formData.get('reminderCategory'),
            reminderType: formData.get('reminderType'),
            reminderTime: formData.get('reminderTime'),
            advanceMinutes: parseInt(formData.get('reminderAdvance')) || 0
        };

        try {
            const response = await fetch('/api/reminders', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(reminderData)
            });

            if (response.ok) {
                const result = await response.json();
                this.reminders.push(result.reminder);
                this.hideReminderModal();
                this.refreshCurrentView();
                this.showToast('提醒已添加', 'success');
            } else {
                throw new Error('Failed to save reminder');
            }
        } catch (error) {
            console.error('Error saving reminder:', error);
            this.showToast('保存失败，请重试', 'error');
        }
    }

    async completeReminder(reminderId) {
        const reminder = this.reminders.find(r => r.id === reminderId);
        if (!reminder) return;

        const recordData = {
            reminderId: reminderId,
            childId: reminder.childId,
            scheduledTime: reminder.reminderTime,
            status: 'completed'
        };

        try {
            const response = await fetch('/api/records', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(recordData)
            });

            if (response.ok) {
                const result = await response.json();
                this.records.push(result.record);
                this.refreshCurrentView();
                this.showToast('任务已完成', 'success');
            }
        } catch (error) {
            console.error('Error completing reminder:', error);
            this.showToast('操作失败，请重试', 'error');
        }
    }

    async skipReminder(reminderId) {
        const reminder = this.reminders.find(r => r.id === reminderId);
        if (!reminder) return;

        const recordData = {
            reminderId: reminderId,
            childId: reminder.childId,
            scheduledTime: reminder.reminderTime,
            status: 'skipped',
            note: '用户选择跳过'
        };

        try {
            const response = await fetch('/api/records', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(recordData)
            });

            if (response.ok) {
                const result = await response.json();
                this.records.push(result.record);
                this.refreshCurrentView();
                this.showToast('任务已跳过', 'warning');
            }
        } catch (error) {
            console.error('Error skipping reminder:', error);
            this.showToast('操作失败，请重试', 'error');
        }
    }

    delayReminder(reminderId) {
        // 延后15分钟
        this.showToast('提醒将在15分钟后再次提醒您', 'info');

        setTimeout(() => {
            this.checkReminder(reminderId);
        }, 15 * 60 * 1000);
    }

    // 通知系统
    async requestNotificationPermission() {
        if ('Notification' in window && Notification.permission === 'default') {
            const permission = await Notification.requestPermission();
            if (permission === 'granted') {
                this.showToast('通知权限已开启', 'success');
            }
        }
    }

    toggleNotifications() {
        if ('Notification' in window) {
            if (Notification.permission === 'granted') {
                this.showToast('通知已开启', 'info');
            } else if (Notification.permission === 'denied') {
                this.showToast('请在浏览器设置中开启通知权限', 'warning');
            } else {
                this.requestNotificationPermission();
            }
        } else {
            this.showToast('您的浏览器不支持通知功能', 'error');
        }
    }

    showNotification(title, body, icon = '👶') {
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification(title, {
                body: body,
                icon: icon,
                tag: 'reminder-' + Date.now(),
                requireInteraction: true
            });
        }
    }

    // 定时检查提醒
    startReminderCheck() {
        // 每分钟检查一次
        setInterval(() => {
            this.checkReminders();
        }, 60 * 1000);

        // 立即检查一次
        this.checkReminders();
    }

    checkReminders() {
        const now = new Date();
        const todayReminders = this.getTodayReminders();

        todayReminders.forEach(reminder => {
            const reminderTime = new Date(reminder.reminderTime);
            const advanceTime = new Date(reminderTime.getTime() - reminder.advanceMinutes * 60 * 1000);

            // 检查是否已经有记录
            const hasRecord = this.records.some(r =>
                r.reminderId === reminder.id &&
                new Date(r.scheduledTime).toDateString() === now.toDateString()
            );

            if (!hasRecord) {
                // 检查是否到达提醒时间
                if (now >= advanceTime && now <= reminderTime) {
                    this.triggerReminder(reminder);
                }
            }
        });
    }

    checkReminder(reminderId) {
        const reminder = this.reminders.find(r => r.id === reminderId);
        if (!reminder) return;

        const hasRecord = this.records.some(r =>
            r.reminderId === reminder.id &&
            new Date(r.scheduledTime).toDateString() === new Date().toDateString()
        );

        if (!hasRecord) {
            this.triggerReminder(reminder);
        }
    }

    triggerReminder(reminder) {
        const child = this.children.find(c => c.id === reminder.childId);
        const category = this.categories.find(c => c.id === reminder.category);

        const title = `⏰ ${reminder.title}`;
        const body = `${child ? child.name + ' - ' : ''}${category ? category.name : ''}`;

        this.showNotification(title, body, category ? category.icon : '📌');
        this.showToast(`提醒：${reminder.title}`, 'info');

        // 播放提示音（可选）
        this.playSound();
    }

    playSound() {
        // 创建简单的提示音
        const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBSuBzvLZiTYIG2m98OScTgwOUqzn7blmFgU7k9n1038sBCdy0fXjljEHFWHB8fCfUg0OWLzw8KpyJAQ4k9r1046NCQclas1hIjgKa0RzU2Twg6MBAAABnta1h3YABCwD/P34NTkKZ0JkQWrcgKQGBAIBqdt+j2IAABcJAP38/zA0BWdGYkZsXnwCpAYDAgWr4uWRZwAAAA/++/9BRXOP2/S7ciAGH7kAcwAAGjgFKQYBqpG8RwhAC1AWTK/u0E0EAQQALCIKck9nRjtzp58GAQL+lN3KlWAAAAAABv7+/zlEcZHf+b16IAUX3+cFAQkxD');
        audio.play();
    }

    // Toast 提示
    showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `
            <span class="toast-message">${message}</span>
        `;

        this.toastContainer.appendChild(toast);

        setTimeout(() => {
            toast.remove();
        }, 3000);
    }

    // 退出登录
    async logout() {
        try {
            await fetch('/api/auth/logout', { method: 'POST' });
            window.location.href = '/login.html';
        } catch (error) {
            console.error('Logout failed:', error);
        }
    }
}

// 初始化应用
const app = new ReminderApp();