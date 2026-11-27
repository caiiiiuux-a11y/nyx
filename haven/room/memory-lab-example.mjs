// A fixed fictional event. Only these fixture values may cross into the lab.
const fact = '纸雀观测站 Paperfinch 把一颗薄荷色纽扣收进了三号抽屉。';
const keyword = 'Paperfinch';

export const memoryLabExample = Object.freeze({
  fact, keyword,
  hold: '记下合成记忆：' + fact,
  search: '查找合成记忆：纸雀观测站把什么收进了几号抽屉？',
  dream: '做梦回看合成记忆'
});
