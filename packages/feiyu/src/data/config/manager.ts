import { http } from '@/services/http';
import { ipfs, ipfsGateway } from '@/services/ipfs';
import { store } from '@/services/store/useStore';
import { timestamp } from '@/utils/base';

import { kDefaultConfig } from '../default';
import { subscribeStorage } from './storage';
import { FeiyuConfig, Subscribe } from './types';

export interface SubscribesStore {
  currentSubscribe: string;
  subscribes: Record<string, Subscribe>;
}

export const kSubscribesKey = 'kSubscribesKey';

class ConfigManager {
  static defaultKey = '默认订阅';
  static defaultConfig: Subscribe = {
    key: ConfigManager.defaultKey,
    link: undefined,
    lastUpdate: 1676205769619,
    config: kDefaultConfig,
  };

  private get _subscribes() {
    return store.get<SubscribesStore>(kSubscribesKey)?.subscribes ?? {};
  }

  private get _currentSubscribe() {
    return (
      store.get<SubscribesStore>(kSubscribesKey)?.currentSubscribe ??
      ConfigManager.defaultKey
    );
  }

  get current(): FeiyuConfig {
    this.init(); // 被动初始化
    return this._subscribes[this._currentSubscribe]?.config ?? kDefaultConfig;
  }

  /**
   * 初始化订阅列表
   */
  async init() {
    const _subscribes =
      store.get<SubscribesStore>(kSubscribesKey)?.subscribes ?? {};
    if (Object.keys(_subscribes).length > 0) {
      return; // 只从本地初始化一次
    }
    // 添加默认配置
    _subscribes[ConfigManager.defaultKey] = ConfigManager.defaultConfig;
    // 加载本地订阅配置
    const subscribes = await subscribeStorage.getAll();
    subscribes.forEach((e) => {
      _subscribes[e.key] = e;
    });
    // 从本地读取当前使用的配置记录
    let _currentSubscribe = ConfigManager.defaultKey;
    const current = subscribeStorage.current();
    if (current) {
      _currentSubscribe = current;
    }
    // 初始化依赖
    store.set(kSubscribesKey, {
      subscribes: _subscribes,
      currentSubscribe: _currentSubscribe,
    });
    // 刷新订阅
    this.refreshAll();
  }

  /**
   * 批量导出订阅
   */
  async exportSubscribes() {
    await this.init();
    // 逆向导出订阅列表（导入时恢复原顺序）
    const datas = Object.values(this._subscribes).reverse();
    const cid = await ipfs.writeJson(datas);
    return cid ? ipfsGateway() + cid : undefined;
  }

  /**
   * 导出单个订阅
   */
  async exportSubscribe(key: string) {
    await this.init();
    // 逆向导出订阅列表（导入时恢复原顺序）
    if (!this._subscribes[key]) return false;
    const datas = [this._subscribes[key]];
    const cid = await ipfs.writeJson(datas);
    return cid ? ipfsGateway() + cid : undefined;
  }

  /**
   * 批量导入订阅(返回导入成功个数)
   */
  async importSubscribes(url: string) {
    await this.init();
    const datas: Subscribe[] =
      (await http.proxy.get(url, { caches: false })) ?? [];
    let successItems = 0;
    const _subscribes = this._subscribes;
    for (const subscribe of datas) {
      const key = subscribe.key;
      const link = subscribe.link;
      // 不能重名
      if (_subscribes[key]) {
        let newName = subscribe.key;
        while (_subscribes[newName]) {
          newName = newName + '(重名)';
        }
        // 解决重名
        subscribe.key = newName;
      }
      // 不能重复添加相同的订阅源
      const subscribeKeys = Object.values(_subscribes);
      const sameLink = subscribeKeys.find((e) => e.link === link);
      if (sameLink) {
        break; // 跳过已添加的订阅源
      }
      // 导入订阅
      const success = await subscribeStorage.set(key, subscribe);
      if (success) {
        _subscribes[key] = subscribe;
        successItems += 1;
      }
    }
    if (successItems > 0) {
      // 更新状态
      store.set(kSubscribesKey, {
        subscribes: _subscribes,
        currentSubscribe: this._currentSubscribe,
      });
    }
    return successItems;
  }

  /**
   * 添加订阅
   */
  async addSubscribe(key: string, link: string) {
    await this.init();
    // 不能重名
    if (this._subscribes[key]) {
      return '此名称已使用，请重新命名';
    }
    // 不能重复添加相同的订阅源
    const subscribeKeys = Object.values(this._subscribes);
    const sameLink = subscribeKeys.find((e) => e.link === link);
    if (sameLink) {
      return `订阅已存在，请先删除：${sameLink.key}`;
    }
    // 查询订阅地址
    const config = await http.proxy.get(link, { caches: false });
    if (config?.feiyuVersion) {
      // 更新订阅
      const newData = {
        key,
        link,
        lastUpdate: timestamp(),
        config,
      };
      const success = await subscribeStorage.set(key, newData);
      if (success) {
        const _subscribes = this._subscribes;
        _subscribes[key] = newData;
        // 更新状态
        store.set(kSubscribesKey, {
          subscribes: _subscribes,
          currentSubscribe: this._currentSubscribe,
        });
        return '添加成功';
      }
    }
    return '获取配置信息失败';
  }

  /**
   * 刷新单个订阅
   */
  async refreshSubscribe(key: string) {
    await this.init();
    const old = this._subscribes[key];
    if (old) {
      const link = old.link;
      if (!link) {
        // 本地配置，无需刷新
        return true;
      }
      const config = await http.proxy.get(link, { caches: false });
      if (config?.feiyuVersion) {
        // 更新订阅
        const newData = {
          key,
          link,
          lastUpdate: timestamp(),
          config,
        };
        const success = await subscribeStorage.set(key, newData);
        if (success) {
          const _subscribes = this._subscribes;
          _subscribes[key] = newData;
          // 更新状态
          store.set(kSubscribesKey, {
            subscribes: _subscribes,
            currentSubscribe: this._currentSubscribe,
          });
          return true;
        }
      }
    }
    return false;
  }

  /**
   * 编辑单个订阅（本地配置，暂不支持重命名）
   */
  async editSubscribe(subscribe: Subscribe) {
    await this.init();
    const key = subscribe.key;
    const old = this._subscribes[key];
    if (old) {
      const newData = {
        ...subscribe,
        lastUpdate: timestamp(),
      };
      const success = await subscribeStorage.set(key, newData);
      if (success) {
        const _subscribes = this._subscribes;
        _subscribes[key] = newData;
        // 更新状态
        store.set(kSubscribesKey, {
          subscribes: _subscribes,
          currentSubscribe: this._currentSubscribe,
        });
        return true;
      }
    }
    return false;
  }

  /**
   * 刷新全部订阅
   */
  async refreshAll() {
    await this.init();
    await Promise.all(
      Object.keys(this._subscribes).map((key) => this.refreshSubscribe(key)),
    );
  }

  /**
   * 删除订阅
   */
  async remove(key: string) {
    await this.init();
    const success = await subscribeStorage.remove(key);
    if (success) {
      const _subscribes = this._subscribes;
      delete _subscribes[key];
      if (!_subscribes[ConfigManager.defaultKey]) {
        _subscribes[ConfigManager.defaultKey] = ConfigManager.defaultConfig;
      }
      // 重置为默认值
      const flag = await this.setCurrent(ConfigManager.defaultKey);
      if (flag) {
        // 更新状态
        store.set(kSubscribesKey, {
          subscribes: _subscribes,
          currentSubscribe: ConfigManager.defaultKey,
        });
        return true;
      }
    }
    return false;
  }

  /**
   * 清空订阅
   */
  async clear() {
    await this.init();
    const success = await subscribeStorage.clear();
    if (success) {
      // 重置为默认值
      const flag = await this.setCurrent(ConfigManager.defaultKey);
      if (flag) {
        // 更新状态
        store.set(kSubscribesKey, {
          subscribes: {
            [ConfigManager.defaultKey]: ConfigManager.defaultConfig,
          },
          currentSubscribe: ConfigManager.defaultKey,
        });
        return true;
      }
    }
    return false;
  }

  /**
   * 选择当前订阅
   */
  async setCurrent(key: string) {
    await this.init();
    // 确保本地存在当前订阅
    if (this._subscribes[key]) {
      const success = await subscribeStorage.setCurrent(key);
      if (success) {
        // 更新状态
        store.set(kSubscribesKey, {
          subscribes: this._subscribes,
          currentSubscribe: key,
        });
        return true;
      }
    }
    return false;
  }
}

export const configs = new ConfigManager();