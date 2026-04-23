// ==UserScript==
// @name         B站UP主快速拉黑（无确认终极版）
// @namespace    https://github.com/
// @version      4.1
// @description  鼠标悬停UP主名字弹出拉黑按钮，点击直接拉黑，无需确认，并优化动态页面下的稳定性
// @author       豆包
// @match        *://*.bilibili.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      api.bilibili.com
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    const BUTTON_CLASS = 'bili-quick-block';
    const BUTTON_LOADING_CLASS = 'is-loading';
    const TOAST_CLASS = 'bili-block-toast';
    const HIDE_DELAY = 220;
    const REQUEST_TIMEOUT = 12000;
    const UP_SELECTOR = [
        'a[href*="space.bilibili.com"]',
        '.bili-video-card__info--owner',
        '.bili-video-card__info--author',
        '.up-name',
        '.user-name',
        '.up-info',
        '.video-card-row .up',
        '.feed-card .up',
        '.bili-dyn-card-video__author',
        '.bili-dyn-title__text',
        '.bili-rich-text-link'
    ].join(',');

    const state = {
        button: null,
        hideTimer: null,
        activeTarget: null,
        activeMid: '',
        activeName: '',
        blockingMid: '',
        positionFrame: 0
    };

    GM_addStyle(`
        .${BUTTON_CLASS} {
            position: absolute;
            z-index: 999999;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 104px;
            padding: 8px 14px;
            border: 0;
            border-radius: 8px;
            background: #fb7299;
            color: #fff;
            font-size: 14px;
            font-weight: 700;
            line-height: 1;
            cursor: pointer;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.22);
            transition: transform 0.18s ease, box-shadow 0.18s ease, background 0.18s ease, opacity 0.18s ease;
            user-select: none;
            white-space: nowrap;
        }
        .${BUTTON_CLASS}:hover {
            background: #f53a71;
            transform: translateY(-1px);
            box-shadow: 0 6px 16px rgba(0, 0, 0, 0.26);
        }
        .${BUTTON_CLASS}:active {
            transform: translateY(0);
        }
        .${BUTTON_CLASS}.${BUTTON_LOADING_CLASS} {
            cursor: wait;
            opacity: 0.82;
            pointer-events: none;
        }
        .${TOAST_CLASS} {
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 1000000;
            max-width: min(360px, calc(100vw - 32px));
            padding: 12px 16px;
            border-radius: 8px;
            color: #fff;
            font-size: 14px;
            line-height: 1.45;
            box-shadow: 0 6px 18px rgba(0, 0, 0, 0.22);
            animation: bili-block-toast-in 0.22s ease;
            word-break: break-word;
        }
        .${TOAST_CLASS}[data-type="success"] {
            background: #00ae66;
        }
        .${TOAST_CLASS}[data-type="error"] {
            background: #f56c6c;
        }
        .${TOAST_CLASS}[data-type="info"] {
            background: #409eff;
        }
        @keyframes bili-block-toast-in {
            from {
                opacity: 0;
                transform: translate3d(12px, 0, 0);
            }
            to {
                opacity: 1;
                transform: translate3d(0, 0, 0);
            }
        }
    `);

    function showToast(message, type = 'success') {
        const toast = document.createElement('div');
        toast.className = TOAST_CLASS;
        toast.dataset.type = type;
        toast.textContent = message;
        document.body.appendChild(toast);

        window.setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translate3d(12px, 0, 0)';
            toast.style.transition = 'all 0.25s ease';
            window.setTimeout(() => toast.remove(), 250);
        }, 2200);
    }

    function clearHideTimer() {
        if (state.hideTimer) {
            window.clearTimeout(state.hideTimer);
            state.hideTimer = null;
        }
    }

    function scheduleHide() {
        clearHideTimer();
        state.hideTimer = window.setTimeout(hideButton, HIDE_DELAY);
    }

    function hideButton() {
        clearHideTimer();
        if (state.button) {
            state.button.remove();
            state.button = null;
        }
        state.activeTarget = null;
        state.activeMid = '';
        state.activeName = '';
    }

    function ensureButton() {
        if (state.button && state.button.isConnected) {
            return state.button;
        }

        const button = document.createElement('button');
        button.type = 'button';
        button.className = BUTTON_CLASS;
        button.textContent = '拉黑该UP';

        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();

            if (!state.activeMid || !state.activeName) {
                showToast('未能识别当前UP主信息，请重试', 'error');
                return;
            }

            doBlock(state.activeMid, state.activeName);
        }, true);

        button.addEventListener('mouseenter', clearHideTimer, true);
        button.addEventListener('mouseleave', (event) => {
            if (isInsideActiveRegion(event.relatedTarget)) {
                return;
            }
            scheduleHide();
        }, true);

        document.body.appendChild(button);
        state.button = button;
        return button;
    }

    function setButtonLoading(isLoading) {
        if (!state.button) {
            return;
        }

        state.button.classList.toggle(BUTTON_LOADING_CLASS, isLoading);
        state.button.textContent = isLoading ? '拉黑中...' : '拉黑该UP';
    }

    function extractMidFromUrl(href) {
        if (!href) {
            return '';
        }

        const match = href.match(/space\.bilibili\.com\/(\d+)/i);
        return match ? match[1] : '';
    }

    function cleanUpName(rawName) {
        if (!rawName) {
            return '';
        }

        return rawName
            .replace(/\s*·\s*(\d+秒前|\d+分钟前|\d+小时前|\d+天前|\d+周前|\d+月前|\d+年前).*$/u, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function findUpLink(element) {
        if (!(element instanceof Element)) {
            return null;
        }

        if (element.matches('a[href*="space.bilibili.com"]')) {
            return element;
        }

        return element.closest('a[href*="space.bilibili.com"]') || element.querySelector('a[href*="space.bilibili.com"]');
    }

    function buildContextFromElement(element) {
        if (!(element instanceof Element)) {
            return null;
        }

        const hit = element.closest(UP_SELECTOR);
        const link = findUpLink(hit || element);
        if (!link) {
            return null;
        }

        const mid = extractMidFromUrl(link.href);
        if (!mid) {
            return null;
        }

        const fallbackText = hit ? hit.textContent : '';
        const rawName = link.getAttribute('title') || link.textContent || fallbackText || '';
        const name = cleanUpName(rawName);
        if (!name) {
            return null;
        }

        return {
            mid,
            name,
            target: link
        };
    }

    function updateButtonPosition() {
        if (!state.button || !state.activeTarget || !state.activeTarget.isConnected) {
            hideButton();
            return;
        }

        const rect = state.activeTarget.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
            hideButton();
            return;
        }

        const button = state.button;
        const top = rect.bottom + window.scrollY + 8;
        const left = Math.min(
            rect.left + window.scrollX,
            Math.max(window.scrollX + 8, window.scrollX + document.documentElement.clientWidth - button.offsetWidth - 8)
        );

        button.style.left = `${Math.max(window.scrollX + 8, left)}px`;
        button.style.top = `${top}px`;
    }

    function requestPositionUpdate() {
        if (state.positionFrame) {
            return;
        }

        state.positionFrame = window.requestAnimationFrame(() => {
            state.positionFrame = 0;
            updateButtonPosition();
        });
    }

    function showBlockButton(context) {
        clearHideTimer();

        const sameTarget = state.activeTarget === context.target && state.activeMid === context.mid;
        state.activeTarget = context.target;
        state.activeMid = context.mid;
        state.activeName = context.name;

        ensureButton();
        if (!sameTarget) {
            setButtonLoading(false);
        }

        requestPositionUpdate();
    }

    function isInsideActiveRegion(node) {
        if (!(node instanceof Element)) {
            return false;
        }

        const inTarget = !!(state.activeTarget && state.activeTarget.contains(node));
        const inButton = !!(state.button && state.button.contains(node));
        return inTarget || inButton;
    }

    function doBlock(mid, name) {
        const csrf = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/)?.[1];
        if (!csrf) {
            showToast('请先登录B站，再执行拉黑操作', 'error');
            return;
        }

        if (state.blockingMid === mid) {
            showToast('正在执行拉黑，请稍候', 'info');
            return;
        }

        state.blockingMid = mid;
        setButtonLoading(true);

        GM_xmlhttpRequest({
            method: 'POST',
            url: 'https://api.bilibili.com/x/relation/modify',
            timeout: REQUEST_TIMEOUT,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                Referer: window.location.href
            },
            data: new URLSearchParams({
                fid: mid,
                act: '5',
                csrf
            }).toString(),
            onload: (response) => {
                let payload = null;

                try {
                    payload = JSON.parse(response.responseText || '{}');
                } catch (error) {
                    console.error('拉黑接口返回无法解析:', error, response.responseText);
                }

                if (response.status >= 200 && response.status < 300 && payload && payload.code === 0) {
                    showToast(`已成功拉黑 UP：${name}`, 'success');
                    hideButton();
                } else {
                    const message = payload && payload.message ? payload.message : `请求失败（HTTP ${response.status || '未知'}）`;
                    showToast(`拉黑失败：${message}`, 'error');
                    setButtonLoading(false);
                }

                state.blockingMid = '';
            },
            onerror: () => {
                state.blockingMid = '';
                setButtonLoading(false);
                showToast('网络错误，拉黑失败', 'error');
            },
            ontimeout: () => {
                state.blockingMid = '';
                setButtonLoading(false);
                showToast('请求超时，拉黑失败', 'error');
            },
            onabort: () => {
                state.blockingMid = '';
                setButtonLoading(false);
                showToast('请求被中断，拉黑失败', 'error');
            }
        });
    }

    function handleMouseOver(event) {
        const context = buildContextFromElement(event.target);
        if (!context) {
            return;
        }

        showBlockButton(context);
    }

    function handleMouseOut(event) {
        if (!state.button && !state.activeTarget) {
            return;
        }

        const leavingActiveTarget = !!(state.activeTarget && event.target instanceof Element && state.activeTarget.contains(event.target));
        const leavingButton = !!(state.button && event.target instanceof Element && state.button.contains(event.target));
        if (!leavingActiveTarget && !leavingButton) {
            return;
        }

        if (isInsideActiveRegion(event.relatedTarget)) {
            return;
        }

        scheduleHide();
    }

    document.addEventListener('mouseover', handleMouseOver, true);
    document.addEventListener('mouseout', handleMouseOut, true);
    window.addEventListener('scroll', requestPositionUpdate, true);
    window.addEventListener('resize', requestPositionUpdate, true);

    console.log('B站UP主快速拉黑（无确认终极版）已加载 v4.1');
})();
